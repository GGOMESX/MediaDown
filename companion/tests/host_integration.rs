//! End-to-end tests of the host binary with the real yt-dlp and ffmpeg.
//! Opt-in: set MEDIADOWN_TEST_YTDLP (yt-dlp executable) and MEDIADOWN_TEST_FFMPEG_DIR
//! (directory containing ffmpeg). Without them each test prints a notice and passes.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const TIMEOUT: Duration = Duration::from_secs(60);

struct Tools {
    yt_dlp: PathBuf,
    ffmpeg_dir: PathBuf,
}

fn tools() -> Option<Tools> {
    let yt_dlp = std::env::var_os("MEDIADOWN_TEST_YTDLP")?;
    let ffmpeg_dir = std::env::var_os("MEDIADOWN_TEST_FFMPEG_DIR")?;
    Some(Tools { yt_dlp: yt_dlp.into(), ffmpeg_dir: ffmpeg_dir.into() })
}

macro_rules! require_tools {
    () => {
        match tools() {
            Some(tools) => tools,
            None => {
                eprintln!("skipped: set MEDIADOWN_TEST_YTDLP and MEDIADOWN_TEST_FFMPEG_DIR to run");
                return;
            }
        }
    };
}

// ---------- media fixtures ----------

fn generate_media(tools: &Tools, dir: &Path) {
    let ffmpeg = tools.ffmpeg_dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    let run = |args: &[&str]| {
        let status = Command::new(&ffmpeg).args(["-hide_banner", "-loglevel", "error", "-y"]).args(args).current_dir(dir).status().unwrap();
        assert!(status.success(), "ffmpeg failed: {args:?}");
    };
    let source = ["-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:duration=3"];
    std::fs::create_dir_all(dir.join("hls")).unwrap();
    run(&[&source[..], &["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", "hls/index.m3u8"]].concat());
    run(&[&source[..], &["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "video.mp4"]].concat());
}

// ---------- tiny HTTP server ----------

struct Server {
    origin: String,
}

fn start_server(root: PathBuf) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let root = root.clone();
            thread::spawn(move || {
                let _ = serve(stream, &root);
            });
        }
    });
    Server { origin }
}

fn serve(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let path = request_line.split_whitespace().nth(1).unwrap_or("/").split('?').next().unwrap().to_owned();
    let mut has_referer = false;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? <= 2 {
            break;
        }
        has_referer |= header.to_ascii_lowercase().starts_with("referer:");
    }

    // /hotlink/* needs a Referer; /slow/* trickles bytes so a cancel can land mid-download.
    let (file, slow) = if let Some(rest) = path.strip_prefix("/hotlink") {
        if !has_referer {
            return stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
        (rest.to_owned(), false)
    } else if let Some(rest) = path.strip_prefix("/slow") {
        (rest.to_owned(), true)
    } else {
        (path, false)
    };

    let Ok(body) = std::fs::read(root.join(file.trim_start_matches('/'))) else {
        return stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    let content_type = if file.ends_with(".m3u8") { "application/vnd.apple.mpegurl" } else { "video/mp4" };
    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len())?;
    if slow {
        for chunk in body.chunks(4096) {
            stream.write_all(chunk)?;
            thread::sleep(Duration::from_millis(200));
        }
        Ok(())
    } else {
        stream.write_all(&body)
    }
}

// ---------- host driver ----------

struct Host {
    child: Child,
    stdin: Option<ChildStdin>,
    events: Receiver<Value>,
    downloads: TempDir,
}

impl Host {
    fn start(tools: &Tools) -> Self {
        let downloads = TempDir::new().unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_mediadown-host"))
            .arg("chrome-extension://test/")
            .env("MEDIADOWN_YTDLP", &tools.yt_dlp)
            .env("MEDIADOWN_FFMPEG_DIR", &tools.ffmpeg_dir)
            .env("MEDIADOWN_DOWNLOAD_DIR", downloads.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, events) = mpsc::channel();
        thread::spawn(move || {
            let mut stdout = stdout;
            loop {
                let mut header = [0u8; 4];
                if stdout.read_exact(&mut header).is_err() {
                    return;
                }
                let mut body = vec![0u8; u32::from_ne_bytes(header) as usize];
                stdout.read_exact(&mut body).unwrap();
                if tx.send(serde_json::from_slice::<Value>(&body).unwrap()).is_err() {
                    return;
                }
            }
        });
        let stdin = child.stdin.take();
        Self { child, stdin, events, downloads }
    }

    fn send(&mut self, message: Value) {
        let body = serde_json::to_vec(&message).unwrap();
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&(body.len() as u32).to_ne_bytes()).unwrap();
        stdin.write_all(&body).unwrap();
        stdin.flush().unwrap();
    }

    /// Collects events until one matches; returns everything seen so far.
    fn wait_for(&self, predicate: impl Fn(&Value) -> bool) -> Vec<Value> {
        let deadline = Instant::now() + TIMEOUT;
        let mut seen = Vec::new();
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            let event = self.events.recv_timeout(remaining).unwrap_or_else(|_| panic!("timed out; events so far: {seen:#?}"));
            let matched = predicate(&event);
            seen.push(event);
            if matched {
                return seen;
            }
        }
        panic!("timed out; events so far: {seen:#?}");
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn download(job_id: &str, url: &str, referer: Option<&str>, file_name: &str, preset: &str) -> Value {
    json!({
        "type": "download", "jobId": job_id, "url": url, "referer": referer, "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "folder": "Media Downloader", "fileName": file_name, "preset": preset
    })
}

fn is_final(job_id: &str) -> impl Fn(&Value) -> bool + '_ {
    move |e| e["jobId"] == job_id && (e["type"] == "done" || e["type"] == "failed")
}

fn fixtures(tools: &Tools) -> (TempDir, Server) {
    let media = TempDir::new().unwrap();
    generate_media(tools, media.path());
    let server = start_server(media.path().to_path_buf());
    (media, server)
}

// ---------- tests ----------

#[test]
fn hello_reports_engine_version() {
    let tools = require_tools!();
    let mut host = Host::start(&tools);
    host.send(json!({ "type": "hello", "protocolVersion": 1 }));
    let events = host.wait_for(|e| e["type"] == "hello");
    let hello = events.last().unwrap();
    assert_eq!(hello["engineReady"], true);
    assert!(hello["engineVersion"].as_str().unwrap().starts_with("20"));
}

#[test]
fn downloads_hls_into_mp4_with_progress() {
    let tools = require_tools!();
    let (_media, server) = fixtures(&tools);
    let mut host = Host::start(&tools);

    host.send(download("hls1", &format!("{}/hls/index.m3u8", server.origin), None, "Aula 1 — Introdução 100%", "best"));
    let events = host.wait_for(is_final("hls1"));

    let types: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(types.first(), Some(&"queued"));
    assert!(types.contains(&"started"));
    assert!(types.contains(&"progress"), "{events:#?}");
    let done = events.last().unwrap();
    assert_eq!(done["type"], "done", "{events:#?}");
    assert_eq!(done["fileName"], "Aula 1 — Introdução 100%.mp4");

    let file = host.downloads.path().join("Media Downloader").join("Aula 1 — Introdução 100%.mp4");
    let bytes = std::fs::read(&file).unwrap();
    assert_eq!(&bytes[4..8], b"ftyp", "output must be a real MP4 container");
}

#[test]
fn sends_referer_so_hotlink_protected_files_work() {
    let tools = require_tools!();
    let (_media, server) = fixtures(&tools);
    let mut host = Host::start(&tools);

    let url = format!("{}/hotlink/video.mp4", server.origin);
    host.send(download("with-ref", &url, Some(&format!("{}/aula.html", server.origin)), "com referer", "best"));
    assert_eq!(host.wait_for(is_final("with-ref")).last().unwrap()["type"], "done");

    host.send(download("no-ref", &url, None, "sem referer", "best"));
    let failed = host.wait_for(is_final("no-ref")).pop().unwrap();
    assert_eq!(failed["type"], "failed");
    assert_eq!(failed["error"], "forbidden", "{failed:#?}");
}

#[test]
fn extracts_audio_as_mp3() {
    let tools = require_tools!();
    let (_media, server) = fixtures(&tools);
    let mut host = Host::start(&tools);

    host.send(download("mp3", &format!("{}/video.mp4", server.origin), None, "trilha", "audioMp3"));
    let done = host.wait_for(is_final("mp3")).pop().unwrap();
    assert_eq!(done["fileName"], "trilha.mp3", "{done:#?}");
    assert!(host.downloads.path().join("Media Downloader/trilha.mp3").is_file());
}

#[test]
fn cancels_a_running_download() {
    let tools = require_tools!();
    let (_media, server) = fixtures(&tools);
    let mut host = Host::start(&tools);

    host.send(download("slow", &format!("{}/slow/video.mp4", server.origin), None, "lento", "best"));
    host.wait_for(|e| e["jobId"] == "slow" && e["type"] == "progress");
    host.send(json!({ "type": "cancel", "jobId": "slow" }));
    let canceled = host.wait_for(is_final("slow")).pop().unwrap();
    assert_eq!(canceled["error"], "canceled", "{canceled:#?}");
}

#[test]
fn rejects_invalid_requests_without_running_anything() {
    let tools = require_tools!();
    let mut host = Host::start(&tools);

    host.send(download("bad-url", "file:///etc/passwd", None, "x", "best"));
    let failed = host.wait_for(is_final("bad-url")).pop().unwrap();
    assert_eq!(failed["error"], "invalidRequest");

    host.send(json!({ "type": "download", "jobId": "x", "url": "https://a.com/v.mp4", "exec": "calc.exe" }));
    host.wait_for(|e| e["type"] == "invalidRequest");

    host.send(json!({ "type": "reveal", "jobId": "never-existed" }));
    host.wait_for(|e| e["type"] == "invalidRequest");
}

#[test]
fn exits_when_the_browser_closes_the_port() {
    let tools = require_tools!();
    let mut host = Host::start(&tools);
    drop(host.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if host.child.try_wait().unwrap().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("host kept running after stdin closed");
}
