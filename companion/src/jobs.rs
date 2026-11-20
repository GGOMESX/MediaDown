use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::engine::{self, DownloadSpec, EngineLine, EnginePaths, Quality};
use crate::platform::{self, ProcessTree};
use crate::protocol::{ErrorCode, Event, PROTOCOL_VERSION, Request};
use crate::recorder::{self, Limits, ProgressParser, RecordSpec, StopReason};
use crate::validation::{self, ValidationError};

const MAX_STDERR_BYTES: usize = 64 * 1024;
const MAX_RECORDINGS: usize = 2;
/// After `q`, ffmpeg normally exits within a second; past this, the tree is killed (the TS stays playable).
const STOP_GRACE: Duration = Duration::from_secs(15);
/// When the browser closes, give recordings this long to finish and be converted to MP4.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
const DISK_CHECK_INTERVAL: Duration = Duration::from_secs(5);

pub enum ManagerMsg {
    Request(Request),
    Invalid(String),
    Finished { job_id: String, outcome: Outcome },
    Shutdown,
}

#[derive(Debug)]
pub enum Outcome {
    Done { path: PathBuf, stop_reason: Option<StopReason> },
    Failed(ErrorCode, String),
}

pub struct Config {
    pub downloads_dir: PathBuf,
    pub engines: EnginePaths,
    pub max_concurrent: usize,
    pub recording_limits: Limits,
}

#[derive(Clone, Copy)]
struct JobOptions {
    quality: Quality,
    subtitles: bool,
}

struct Source {
    url: String,
    referer: Option<String>,
    user_agent: Option<String>,
    output_dir: PathBuf,
    /// Sanitized file name without extension (not yet escaped for yt-dlp templates).
    stem: String,
}

struct QueuedJob {
    id: String,
    source: Source,
    options: JobOptions,
}

/// Handle used to end a recording cleanly: `q` on ffmpeg's stdin.
struct Recording {
    stdin: Mutex<Option<ChildStdin>>,
    reason: Mutex<Option<StopReason>>,
}

impl Recording {
    fn request_stop(&self, reason: Option<StopReason>) {
        if let Some(reason) = reason {
            self.reason.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert(reason);
        }
        if let Some(mut stdin) = self.stdin.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }
    }

    fn reason(&self) -> Option<StopReason> {
        *self.reason.lock().unwrap_or_else(|p| p.into_inner())
    }
}

struct RunningJob {
    child: Arc<Mutex<Child>>,
    tree: Arc<ProcessTree>,
    canceled: Arc<AtomicBool>,
    recording: Option<Arc<Recording>>,
}

impl RunningJob {
    fn terminate(&self) {
        let mut child = self.child.lock().unwrap_or_else(|p| p.into_inner());
        let _ = self.tree.terminate(&mut child);
    }
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
        while let Ok(message) = inbox.recv() {
            match message {
                ManagerMsg::Request(request) => self.handle_request(request),
                ManagerMsg::Invalid(detail) => self.emit(Event::InvalidRequest { detail }),
                ManagerMsg::Finished { job_id, outcome } => self.finish(job_id, outcome),
                ManagerMsg::Shutdown => break,
            }
        }
        self.shutdown(&inbox);
    }

    fn handle_request(&mut self, request: Request) {
        match request {
            Request::Hello { .. } => self.say_hello(),
            Request::Download { job_id, url, referer, user_agent, folder, file_name, quality, subtitles } => {
                let options = JobOptions { quality, subtitles };
                if !options.quality.is_valid() {
                    return self.reject(job_id, ValidationError::InvalidQuality);
                }
                match self.validate(&job_id, &url, referer, user_agent, &folder, &file_name) {
                    Ok((id, source)) => self.enqueue(QueuedJob { id, source, options }),
                    Err(error) => self.reject(job_id, error),
                }
            }
            Request::Record { job_id, url, referer, user_agent, folder, file_name } => {
                match self.validate(&job_id, &url, referer, user_agent, &folder, &file_name) {
                    Ok((id, source)) => self.start_recording(id, source),
                    Err(error) => self.reject(job_id, error),
                }
            }
            Request::Stop { job_id } => self.stop(&job_id),
            Request::Cancel { job_id } => self.cancel(&job_id),
            Request::Reveal { job_id } => self.reveal(&job_id),
        }
    }

    fn validate(
        &self,
        job_id: &str,
        url: &str,
        referer: Option<String>,
        user_agent: Option<String>,
        folder: &str,
        file_name: &str,
    ) -> Result<(String, Source), ValidationError> {
        let id = validation::validate_job_id(job_id)?;
        if self.known_ids.contains(&id) {
            return Err(ValidationError::InvalidJobId);
        }
        let source = Source {
            url: validation::validate_url(url)?.to_string(),
            referer: referer.as_deref().map(validation::validate_url).transpose()?.map(|u| u.to_string()),
            user_agent: user_agent.as_deref().map(validation::validate_header_value).transpose()?,
            output_dir: validation::resolve_output_dir(&self.config.downloads_dir, folder),
            stem: validation::sanitize_stem(file_name),
        };
        Ok((id, source))
    }

    fn reject(&self, job_id: String, error: ValidationError) {
        self.emit(Event::Failed { job_id, error: ErrorCode::InvalidRequest, detail: format!("{error:?}") });
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

    // ---------- downloads (yt-dlp, queued) ----------

    fn enqueue(&mut self, job: QueuedJob) {
        self.known_ids.insert(job.id.clone());
        self.emit(Event::Queued { job_id: job.id.clone() });
        self.queue.push_back(job);
        self.start_next();
    }

    /// Recordings run beside the queue: a long live must not block downloads.
    fn running_downloads(&self) -> usize {
        self.running.values().filter(|job| job.recording.is_none()).count()
    }

    fn start_next(&mut self) {
        while self.running_downloads() < self.config.max_concurrent {
            let Some(job) = self.queue.pop_front() else { return };
            let job_id = job.id.clone();
            match self.spawn_download(job) {
                Ok(running) => {
                    self.running.insert(job_id.clone(), running);
                    self.emit(Event::Started { job_id });
                }
                Err((error, detail)) => self.emit(Event::Failed { job_id, error, detail }),
            }
        }
    }

    fn spawn_download(&self, job: QueuedJob) -> Result<RunningJob, (ErrorCode, String)> {
        let engines = &self.config.engines;
        if !engines.is_ready() {
            return Err((ErrorCode::EngineMissing, format!("yt-dlp não encontrado em {}", engines.yt_dlp.display())));
        }
        std::fs::create_dir_all(&job.source.output_dir).map_err(|e| (ErrorCode::Unknown, e.to_string()))?;

        let stem = validation::escape_output_template(&job.source.stem);
        let spec = DownloadSpec {
            url: &job.source.url,
            referer: job.source.referer.as_deref(),
            user_agent: job.source.user_agent.as_deref(),
            output_dir: &job.source.output_dir,
            output_stem: &stem,
            quality: job.options.quality,
            subtitles: job.options.subtitles,
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

        let (child, tree, stdout, stderr, _) = spawn_tracked(command)?;
        let canceled = Arc::new(AtomicBool::new(false));
        let watcher = DownloadWatcher {
            job_id: job.id,
            child: Arc::clone(&child),
            canceled: Arc::clone(&canceled),
            events: self.events.clone(),
            manager: self.self_tx.clone(),
        };
        thread::spawn(move || watcher.watch(stdout, stderr));
        Ok(RunningJob { child, tree, canceled, recording: None })
    }

    // ---------- recordings (ffmpeg, immediate) ----------

    fn start_recording(&mut self, job_id: String, source: Source) {
        self.known_ids.insert(job_id.clone());
        match self.spawn_recording(&job_id, source) {
            Ok(running) => {
                self.running.insert(job_id.clone(), running);
                self.emit(Event::Started { job_id });
            }
            Err((error, detail)) => self.emit(Event::Failed { job_id, error, detail }),
        }
    }

    fn spawn_recording(&self, job_id: &str, source: Source) -> Result<RunningJob, (ErrorCode, String)> {
        let recordings = self.running.values().filter(|job| job.recording.is_some()).count();
        if recordings >= MAX_RECORDINGS {
            return Err((ErrorCode::Busy, format!("no máximo {MAX_RECORDINGS} gravações ao mesmo tempo")));
        }
        let ffmpeg = recorder::ffmpeg_binary(&self.config.engines.ffmpeg_dir);
        if !ffmpeg.is_file() {
            return Err((ErrorCode::EngineMissing, format!("ffmpeg não encontrado em {}", ffmpeg.display())));
        }
        std::fs::create_dir_all(&source.output_dir).map_err(|e| (ErrorCode::Unknown, e.to_string()))?;
        let limits = self.config.recording_limits;
        if recorder::free_space(&source.output_dir).is_some_and(|free| free < limits.min_free_bytes) {
            return Err((ErrorCode::DiskFull, "pouco espaço livre em disco para gravar".into()));
        }

        let (ts, mp4) = recorder::unique_paths(&source.output_dir, &source.stem);
        let spec = RecordSpec {
            url: &source.url,
            referer: source.referer.as_deref(),
            user_agent: source.user_agent.as_deref(),
            output: &ts,
            max_seconds: limits.max_seconds,
        };
        let mut command = Command::new(&ffmpeg);
        command
            .args(recorder::record_args(&spec))
            // stdin is piped (not inherited): it carries the `q` that stops the recording cleanly.
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let (child, tree, stdout, stderr, stdin) = spawn_tracked(command)?;
        let recording = Arc::new(Recording { stdin: Mutex::new(stdin), reason: Mutex::new(None) });
        let watcher = RecordWatcher {
            job_id: job_id.to_owned(),
            child: Arc::clone(&child),
            recording: Arc::clone(&recording),
            events: self.events.clone(),
            manager: self.self_tx.clone(),
            ts,
            mp4,
            ffmpeg,
            limits,
        };
        thread::spawn(move || watcher.watch(stdout, stderr));
        Ok(RunningJob { child, tree, canceled: Arc::new(AtomicBool::new(false)), recording: Some(recording) })
    }

    fn stop(&mut self, job_id: &str) {
        let Some(running) = self.running.get(job_id) else { return };
        let Some(recording) = &running.recording else { return self.cancel(job_id) };
        recording.request_stop(None);

        // Safety net: if ffmpeg ignores `q`, kill it; the TS written so far stays playable.
        let (child, tree) = (Arc::clone(&running.child), Arc::clone(&running.tree));
        thread::spawn(move || {
            thread::sleep(STOP_GRACE);
            let mut child = child.lock().unwrap_or_else(|p| p.into_inner());
            if matches!(child.try_wait(), Ok(None)) {
                let _ = tree.terminate(&mut child);
            }
        });
    }

    fn cancel(&mut self, job_id: &str) {
        if let Some(index) = self.queue.iter().position(|job| job.id == job_id) {
            self.queue.remove(index);
            self.emit(Event::Failed { job_id: job_id.to_owned(), error: ErrorCode::Canceled, detail: String::new() });
        } else if let Some(running) = self.running.get(job_id) {
            if running.recording.is_some() {
                // Never throw a recording away: cancelling one saves what was recorded.
                return self.stop(job_id);
            }
            running.canceled.store(true, Ordering::SeqCst);
            running.terminate();
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
            Outcome::Done { path, stop_reason } => {
                let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                self.completed.insert(job_id.clone(), path);
                self.emit(Event::Done { job_id, file_name, stop_reason });
            }
            Outcome::Failed(error, detail) => self.emit(Event::Failed { job_id, error, detail }),
        }
        self.start_next();
    }

    /// Browser closed: downloads die at once; recordings get a chance to stop and become MP4.
    fn shutdown(&mut self, inbox: &Receiver<ManagerMsg>) {
        for running in self.running.values() {
            match &running.recording {
                Some(recording) => recording.request_stop(None),
                None => running.terminate(),
            }
        }
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while self.running.values().any(|job| job.recording.is_some()) {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else { break };
            match inbox.recv_timeout(remaining) {
                Ok(ManagerMsg::Finished { job_id, outcome }) => self.finish(job_id, outcome),
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
            }
        }
        for running in self.running.values() {
            running.terminate();
        }
    }

    fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }
}

type Spawned = (Arc<Mutex<Child>>, Arc<ProcessTree>, std::process::ChildStdout, std::process::ChildStderr, Option<ChildStdin>);

fn spawn_tracked(mut command: Command) -> Result<Spawned, (ErrorCode, String)> {
    platform::configure_command(&mut command);
    let mut child = command.spawn().map_err(|e| (ErrorCode::EngineMissing, e.to_string()))?;
    let tree = ProcessTree::attach(&child).map_err(|e| {
        let _ = child.kill();
        (ErrorCode::Unknown, e.to_string())
    })?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let stdin = child.stdin.take();
    Ok((Arc::new(Mutex::new(child)), Arc::new(tree), stdout, stderr, stdin))
}

struct DownloadWatcher {
    job_id: String,
    child: Arc<Mutex<Child>>,
    canceled: Arc<AtomicBool>,
    events: Sender<Event>,
    manager: Sender<ManagerMsg>,
}

impl DownloadWatcher {
    fn watch(self, stdout: impl Read, stderr: impl Read + Send + 'static) {
        let stderr_reader = thread::spawn(move || read_tail(stderr, MAX_STDERR_BYTES));
        let final_path = self.follow_progress(stdout);
        let stderr_text = stderr_reader.join().unwrap_or_default();
        let status = self.child.lock().unwrap_or_else(|p| p.into_inner()).wait();

        let outcome = if self.canceled.load(Ordering::SeqCst) {
            Outcome::Failed(ErrorCode::Canceled, String::new())
        } else {
            match (status, final_path) {
                (Ok(status), Some(path)) if status.success() => Outcome::Done { path, stop_reason: None },
                _ => Outcome::Failed(engine::classify_error(&stderr_text), engine::error_detail(&stderr_text)),
            }
        };
        let _ = self.manager.send(ManagerMsg::Finished { job_id: self.job_id, outcome });
    }

    fn follow_progress(&self, stdout: impl Read) -> Option<PathBuf> {
        let mut final_path = None;
        for_each_line(stdout, |line| match engine::parse_line(line) {
            Some(EngineLine::Progress { downloaded_bytes, total_bytes, speed, eta_seconds }) => {
                let _ = self.events.send(Event::Progress {
                    job_id: self.job_id.clone(),
                    downloaded_bytes,
                    total_bytes,
                    speed,
                    eta_seconds,
                    elapsed_seconds: None,
                });
            }
            Some(EngineLine::Done { path }) => final_path = Some(path),
            None => {}
        });
        final_path
    }
}

struct RecordWatcher {
    job_id: String,
    child: Arc<Mutex<Child>>,
    recording: Arc<Recording>,
    events: Sender<Event>,
    manager: Sender<ManagerMsg>,
    ts: PathBuf,
    mp4: PathBuf,
    ffmpeg: PathBuf,
    limits: Limits,
}

impl RecordWatcher {
    fn watch(self, stdout: impl Read, stderr: impl Read + Send + 'static) {
        let stderr_reader = thread::spawn(move || read_tail(stderr, MAX_STDERR_BYTES));
        let elapsed = self.follow_progress(stdout);
        let stderr_text = stderr_reader.join().unwrap_or_default();
        let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).wait();

        let recorded_anything = std::fs::metadata(&self.ts).is_ok_and(|m| m.len() > 0);
        let outcome = if recorded_anything {
            let reached_limit = elapsed.is_some_and(|seconds| seconds + 1 >= self.limits.max_seconds);
            let stop_reason = self.recording.reason().or(reached_limit.then_some(StopReason::MaxDuration));
            Outcome::Done { path: self.finalize(), stop_reason }
        } else {
            let _ = std::fs::remove_file(&self.ts);
            Outcome::Failed(engine::classify_ffmpeg_error(&stderr_text), stderr_text.lines().last().unwrap_or_default().chars().take(300).collect())
        };
        let _ = self.manager.send(ManagerMsg::Finished { job_id: self.job_id, outcome });
    }

    /// Returns the last recorded position, in seconds.
    fn follow_progress(&self, stdout: impl Read) -> Option<u64> {
        let mut parser = ProgressParser::default();
        let mut elapsed = None;
        let mut last_disk_check = Instant::now();
        let disk_dir = self.ts.parent().map(Path::to_path_buf).unwrap_or_default();

        for_each_line(stdout, |line| {
            let Some(progress) = parser.feed(line) else { return };
            elapsed = progress.elapsed_seconds.or(elapsed);
            let _ = self.events.send(Event::Progress {
                job_id: self.job_id.clone(),
                downloaded_bytes: progress.bytes,
                total_bytes: None,
                speed: None,
                eta_seconds: None,
                elapsed_seconds: progress.elapsed_seconds,
            });
            if last_disk_check.elapsed() >= DISK_CHECK_INTERVAL {
                last_disk_check = Instant::now();
                if recorder::free_space(&disk_dir).is_some_and(|free| free < self.limits.min_free_bytes) {
                    self.recording.request_stop(Some(StopReason::DiskFull));
                }
            }
        });
        elapsed
    }

    /// MP4 when the remux works; otherwise the TS is kept as is (still playable).
    fn finalize(&self) -> PathBuf {
        let mut command = Command::new(&self.ffmpeg);
        command.args(recorder::remux_args(&self.ts, &self.mp4)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        platform::configure_command(&mut command);
        let remuxed = command.status().is_ok_and(|status| status.success()) && std::fs::metadata(&self.mp4).is_ok_and(|m| m.len() > 0);
        if remuxed {
            let _ = std::fs::remove_file(&self.ts);
            self.mp4.clone()
        } else {
            let _ = std::fs::remove_file(&self.mp4);
            self.ts.clone()
        }
    }
}

fn for_each_line(source: impl Read, mut handle: impl FnMut(&str)) {
    let mut reader = BufReader::new(source);
    let mut line = Vec::new();
    while reader.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
        handle(&String::from_utf8_lossy(&line));
        line.clear();
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
