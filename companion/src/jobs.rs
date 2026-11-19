use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::engine::{self, DownloadSpec, EngineLine, EnginePaths, Preset};
use crate::platform::{self, ProcessTree};
use crate::protocol::{ErrorCode, Event, PROTOCOL_VERSION, Request};
use crate::validation::{self, ValidationError};

const MAX_STDERR_BYTES: usize = 64 * 1024;

pub enum ManagerMsg {
    Request(Request),
    Invalid(String),
    Finished { job_id: String, outcome: Outcome },
    Shutdown,
}

#[derive(Debug)]
pub enum Outcome {
    Done(PathBuf),
    Failed(ErrorCode, String),
}

pub struct Config {
    pub downloads_dir: PathBuf,
    pub engines: EnginePaths,
    pub max_concurrent: usize,
}

struct QueuedJob {
    id: String,
    url: String,
    referer: Option<String>,
    user_agent: Option<String>,
    output_dir: PathBuf,
    stem: String,
    preset: Preset,
}

struct RunningJob {
    child: Arc<Mutex<Child>>,
    tree: ProcessTree,
    canceled: Arc<AtomicBool>,
}

pub struct JobManager {
    config: Config,
    events: Sender<Event>,
    self_tx: Sender<ManagerMsg>,
    queue: VecDeque<QueuedJob>,
    running: HashMap<String, RunningJob>,
    /// Only paths this host produced can be revealed; the extension never sends a path.
    completed: HashMap<String, PathBuf>,
    known_ids: HashSet<String>,
}

impl JobManager {
    pub fn new(config: Config, events: Sender<Event>, self_tx: Sender<ManagerMsg>) -> Self {
        Self { config, events, self_tx, queue: VecDeque::new(), running: HashMap::new(), completed: HashMap::new(), known_ids: HashSet::new() }
    }

    pub fn run(mut self, inbox: Receiver<ManagerMsg>) {
        for message in inbox {
            match message {
                ManagerMsg::Request(request) => self.handle_request(request),
                ManagerMsg::Invalid(detail) => self.emit(Event::InvalidRequest { detail }),
                ManagerMsg::Finished { job_id, outcome } => self.finish(job_id, outcome),
                ManagerMsg::Shutdown => break,
            }
        }
        self.terminate_all();
    }

    fn handle_request(&mut self, request: Request) {
        match request {
            Request::Hello { .. } => self.say_hello(),
            Request::Download { job_id, url, referer, user_agent, folder, file_name, preset } => {
                match self.validate_job(job_id.clone(), &url, referer, user_agent, &folder, &file_name, preset) {
                    Ok(job) => self.enqueue(job),
                    Err(error) => self.emit(Event::Failed { job_id, error: ErrorCode::InvalidRequest, detail: format!("{error:?}") }),
                }
            }
            Request::Cancel { job_id } => self.cancel(&job_id),
            Request::Reveal { job_id } => self.reveal(&job_id),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn validate_job(
        &self,
        job_id: String,
        url: &str,
        referer: Option<String>,
        user_agent: Option<String>,
        folder: &str,
        file_name: &str,
        preset: Preset,
    ) -> Result<QueuedJob, ValidationError> {
        let id = validation::validate_job_id(&job_id)?;
        if self.known_ids.contains(&id) {
            return Err(ValidationError::InvalidJobId);
        }
        Ok(QueuedJob {
            id,
            url: validation::validate_url(url)?.to_string(),
            referer: referer.as_deref().map(validation::validate_url).transpose()?.map(|u| u.to_string()),
            user_agent: user_agent.as_deref().map(validation::validate_header_value).transpose()?,
            output_dir: validation::resolve_output_dir(&self.config.downloads_dir, folder),
            stem: validation::escape_output_template(&validation::sanitize_stem(file_name)),
            preset,
        })
    }

    fn say_hello(&self) {
        let engines = &self.config.engines;
        let engine_version = engines.is_ready().then(|| engine_version(&engines.yt_dlp)).flatten();
        self.emit(Event::Hello {
            protocol_version: PROTOCOL_VERSION,
            host_version: env!("CARGO_PKG_VERSION").to_owned(),
            engine_ready: engine_version.is_some(),
            engine_version,
        });
    }

    fn enqueue(&mut self, job: QueuedJob) {
        self.known_ids.insert(job.id.clone());
        self.emit(Event::Queued { job_id: job.id.clone() });
        self.queue.push_back(job);
        self.start_next();
    }

    fn start_next(&mut self) {
        while self.running.len() < self.config.max_concurrent {
            let Some(job) = self.queue.pop_front() else { return };
            let job_id = job.id.clone();
            match self.spawn(job) {
                Ok(running) => {
                    self.running.insert(job_id.clone(), running);
                    self.emit(Event::Started { job_id });
                }
                Err((error, detail)) => self.emit(Event::Failed { job_id, error, detail }),
            }
        }
    }

    fn spawn(&self, job: QueuedJob) -> Result<RunningJob, (ErrorCode, String)> {
        let engines = &self.config.engines;
        if !engines.is_ready() {
            return Err((ErrorCode::EngineMissing, format!("yt-dlp não encontrado em {}", engines.yt_dlp.display())));
        }
        std::fs::create_dir_all(&job.output_dir).map_err(|e| (ErrorCode::Unknown, e.to_string()))?;

        let spec = DownloadSpec {
            url: &job.url,
            referer: job.referer.as_deref(),
            user_agent: job.user_agent.as_deref(),
            output_dir: &job.output_dir,
            output_stem: &job.stem,
            preset: job.preset,
        };
        let mut command = Command::new(&engines.yt_dlp);
        command
            .args(engine::build_args(&spec, engines))
            // Never inherit our stdin/stdout: they are the browser's native messaging pipes.
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1");
        platform::configure_command(&mut command);

        let mut child = command.spawn().map_err(|e| (ErrorCode::EngineMissing, e.to_string()))?;
        let tree = ProcessTree::attach(&child).map_err(|e| {
            let _ = child.kill();
            (ErrorCode::Unknown, e.to_string())
        })?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");

        let child = Arc::new(Mutex::new(child));
        let canceled = Arc::new(AtomicBool::new(false));
        let watcher = Watcher {
            job_id: job.id,
            child: Arc::clone(&child),
            canceled: Arc::clone(&canceled),
            events: self.events.clone(),
            manager: self.self_tx.clone(),
        };
        thread::spawn(move || watcher.watch(stdout, stderr));

        Ok(RunningJob { child, tree, canceled })
    }

    fn cancel(&mut self, job_id: &str) {
        if let Some(index) = self.queue.iter().position(|job| job.id == job_id) {
            self.queue.remove(index);
            self.emit(Event::Failed { job_id: job_id.to_owned(), error: ErrorCode::Canceled, detail: String::new() });
        } else if let Some(running) = self.running.get(job_id) {
            running.canceled.store(true, Ordering::SeqCst);
            let mut child = running.child.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = running.tree.terminate(&mut child);
        }
    }

    fn reveal(&self, job_id: &str) {
        match self.completed.get(job_id) {
            Some(path) if path.exists() => {
                let _ = platform::reveal_in_file_manager(path);
            }
            _ => self.emit(Event::InvalidRequest { detail: format!("nothing to reveal for job {job_id}") }),
        }
    }

    fn finish(&mut self, job_id: String, outcome: Outcome) {
        self.running.remove(&job_id);
        match outcome {
            Outcome::Done(path) => {
                let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                self.completed.insert(job_id.clone(), path);
                self.emit(Event::Done { job_id, file_name });
            }
            Outcome::Failed(error, detail) => self.emit(Event::Failed { job_id, error, detail }),
        }
        self.start_next();
    }

    fn terminate_all(&mut self) {
        for running in self.running.values() {
            let mut child = running.child.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = running.tree.terminate(&mut child);
        }
    }

    fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }
}

struct Watcher {
    job_id: String,
    child: Arc<Mutex<Child>>,
    canceled: Arc<AtomicBool>,
    events: Sender<Event>,
    manager: Sender<ManagerMsg>,
}

impl Watcher {
    fn watch(self, stdout: impl Read, stderr: impl Read + Send + 'static) {
        let stderr_reader = thread::spawn(move || read_tail(stderr, MAX_STDERR_BYTES));
        let final_path = self.follow_progress(stdout);
        let stderr_text = stderr_reader.join().unwrap_or_default();
        let status = self.child.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).wait();

        let outcome = if self.canceled.load(Ordering::SeqCst) {
            Outcome::Failed(ErrorCode::Canceled, String::new())
        } else {
            match (status, final_path) {
                (Ok(status), Some(path)) if status.success() => Outcome::Done(path),
                _ => Outcome::Failed(engine::classify_error(&stderr_text), engine::error_detail(&stderr_text)),
            }
        };
        let _ = self.manager.send(ManagerMsg::Finished { job_id: self.job_id, outcome });
    }

    fn follow_progress(&self, stdout: impl Read) -> Option<PathBuf> {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        let mut final_path = None;
        while reader.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
            match engine::parse_line(&String::from_utf8_lossy(&line)) {
                Some(EngineLine::Progress { downloaded_bytes, total_bytes, speed, eta_seconds }) => {
                    let _ = self.events.send(Event::Progress { job_id: self.job_id.clone(), downloaded_bytes, total_bytes, speed, eta_seconds });
                }
                Some(EngineLine::Done { path }) => final_path = Some(path),
                None => {}
            }
            line.clear();
        }
        final_path
    }
}

fn read_tail(mut source: impl Read, max_bytes: usize) -> String {
    let mut collected = Vec::new();
    let mut buffer = [0u8; 8192];
    while let Ok(read) = source.read(&mut buffer) {
        if read == 0 {
            break;
        }
        collected.extend_from_slice(&buffer[..read]);
        if collected.len() > max_bytes {
            collected.drain(..collected.len() - max_bytes);
        }
    }
    String::from_utf8_lossy(&collected).into_owned()
}

fn engine_version(yt_dlp: &Path) -> Option<String> {
    let mut command = Command::new(yt_dlp);
    command.arg("--version").stdin(Stdio::null()).stderr(Stdio::null());
    platform::configure_command(&mut command);
    let output = command.output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned()).filter(|v| !v.is_empty())
}
