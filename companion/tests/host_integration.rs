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

    // Two renditions behind a master playlist, plus a Portuguese subtitle track.
    for (height, width) in [(240, 320), (120, 160)] {
        std::fs::create_dir_all(dir.join(format!("multi/{height}"))).unwrap();
        let scale = format!("scale={width}:{height}");
        let output = format!("multi/{height}/index.m3u8");
        run(&[&source[..], &["-vf", &scale, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", &output]].concat());
    }
    std::fs::create_dir_all(dir.join("multi/subs")).unwrap();
    std::fs::write(dir.join("multi/subs/pt.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nOlá, mundo\n").unwrap();
    std::fs::write(dir.join("multi/subs/pt.m3u8"), "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:3.0,\npt.vtt\n#EXT-X-ENDLIST\n").unwrap();
    std::fs::write(
        dir.join("multi/master.m3u8"),
        concat!(
            "#EXTM3U\n",
            "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"Português\",LANGUAGE=\"pt\",URI=\"subs/pt.m3u8\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=320x240,SUBTITLES=\"subs\"\n240/index.m3u8\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x120,SUBTITLES=\"subs\"\n120/index.m3u8\n",
        ),
    )
    .unwrap();
}

/// Frame size of a video file, read from ffmpeg's stream summary (no ffprobe needed).
fn video_size(tools: &Tools, file: &Path) -> String {
    let ffmpeg = tools.ffmpeg_dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    let output = Command::new(ffmpeg).args(["-hide_banner", "-i"]).arg(file).output().unwrap();
    let info = String::from_utf8_lossy(&output.stderr).into_owned();
    let video_line = info.lines().find(|l| l.contains("Video:")).unwrap_or_else(|| panic!("no video stream: {info}"));
    video_line.split([',', ' ']).find(|part| part.contains('x') && part.split('x').all(|n| n.parse::<u32>().is_ok())).unwrap().to_owned()
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
    let content_type = if file.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else if file.ends_with(".vtt") {
        "text/vtt"
    } else {
        "video/mp4"
    };
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
    fn wait_for(&self, mut predicate: impl FnMut(&Value) -> bool) -> Vec<Value> {
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

impl Host {
    /// Waits until every job has finished, in whatever order; returns each job's final event.
    fn wait_for_jobs(&self, job_ids: &[&str]) -> Vec<Value> {
        let mut finals: Vec<Option<Value>> = vec![None; job_ids.len()];
        self.wait_for(|event| {
            if let Some(index) = job_ids.iter().position(|id| is_final(id)(event)) {
                finals[index] = Some(event.clone());
            }
            finals.iter().all(Option::is_some)
        });
        finals.into_iter().map(Option::unwrap).collect()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn download(job_id: &str, url: &str, referer: Option<&str>, file_name: &str, quality: Value) -> Value {
    json!({
        "type": "download", "jobId": job_id, "url": url, "referer": referer, "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "folder": "Media Downloader", "fileName": file_name, "quality": quality, "subtitles": false
    })
}

fn best() -> Value {
    json!({ "mode": "best" })
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

    host.send(download("hls1", &format!("{}/hls/index.m3u8", server.origin), None, "Aula 1 — Introdução 100%", best()));
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
    host.send(download("with-ref", &url, Some(&format!("{}/aula.html", server.origin)), "com referer", best()));
    assert_eq!(host.wait_for(is_final("with-ref")).last().unwrap()["type"], "done");

    host.send(download("no-ref", &url, None, "sem referer", best()));
    let failed = host.wait_for(is_final("no-ref")).pop().unwrap();
    assert_eq!(failed["type"], "failed");
    assert_eq!(failed["error"], "forbidden", "{failed:#?}");
}

#[test]
fn extracts_audio_as_mp3() {
    let tools = require_tools!();
    let (_media, server) = fixtures(&tools);
    let mut host = Host::start(&tools);

    host.send(download("mp3", &format!("{}/video.mp4", server.origin), None, "trilha", json!({ "mode": "audioMp3" })));
    let done = host.wait_for(is_final("mp3")).pop().unwrap();
    assert_eq!(done["fileName"], "trilha.mp3", "{done:#?}");
    assert!(host.downloads.path().join("Media Downloader/trilha.mp3").is_file());
}

#[test]
fn cancels_a_running_download() {
    let tools = require_tools!();
    let (_media, server) = fixtures(&tools);
    let mut host = Host::start(&tools);

    host.send(download("slow", &format!("{}/slow/video.mp4", server.origin), None, "lento", best()));
    host.wait_for(|e| e["jobId"] == "slow" && e["type"] == "progress");
    host.send(json!({ "type": "cancel", "jobId": "slow" }));
    let canceled = host.wait_for(is_final("slow")).pop().unwrap();
    assert_eq!(canceled["error"], "canceled", "{canceled:#?}");
}

#[test]
fn rejects_invalid_requests_without_running_anything() {
    let tools = require_tools!();
    let mut host = Host::start(&tools);

    host.send(download("bad-url", "file:///etc/passwd", None, "x", best()));
    let failed = host.wait_for(is_final("bad-url")).pop().unwrap();
    assert_eq!(failed["error"], "invalidRequest");

    host.send(json!({ "type": "download", "jobId": "x", "url": "https://a.com/v.mp4", "exec": "calc.exe" }));
    host.wait_for(|e| e["type"] == "invalidRequest");

    host.send(json!({ "type": "reveal", "jobId": "never-existed" }));
    host.wait_for(|e| e["type"] == "invalidRequest");
}

#[test]
fn picks_the_requested_resolution() {
    let tools = require_tools!();
    let (_media, server) = fixtures(&tools);
    let mut host = Host::start(&tools);
    let master = format!("{}/multi/master.m3u8", server.origin);

    host.send(download("small", &master, None, "pequeno", json!({ "mode": "maxHeight", "height": 144 })));
    host.send(download("large", &master, None, "grande", best()));
    // Both run in parallel and may finish in any order.
    let finals = host.wait_for_jobs(&["small", "large"]);
    assert!(finals.iter().all(|event| event["type"] == "done"), "{finals:#?}");

    let folder = host.downloads.path().join("Media Downloader");
    assert_eq!(video_size(&tools, &folder.join("pequeno.mp4")), "160x120");
    assert_eq!(video_size(&tools, &folder.join("grande.mp4")), "320x240");
}

#[test]
fn rejects_absurd_heights() {
    let tools = require_tools!();
    let mut host = Host::start(&tools);
    host.send(download("tiny", "https://a.example.com/v.m3u8", None, "x", json!({ "mode": "maxHeight", "height": 1 })));
    assert_eq!(host.wait_for(is_final("tiny")).pop().unwrap()["error"], "invalidRequest");
}

#[test]
fn saves_stream_subtitles_as_srt_next_to_the_video() {
    let tools = require_tools!();
    let (_media, server) = fixtures(&tools);
    let mut host = Host::start(&tools);

    let mut request = download("subs", &format!("{}/multi/master.m3u8", server.origin), None, "com legenda", best());
    request["subtitles"] = json!(true);
    host.send(request);
    let done = host.wait_for(is_final("subs")).pop().unwrap();
    assert_eq!(done["type"], "done", "{done:#?}");

    let srt = host.downloads.path().join("Media Downloader").join("com legenda.pt.srt");
    let text = std::fs::read_to_string(&srt).unwrap_or_else(|_| panic!("missing {}", srt.display()));
    assert!(text.contains("00:00:00,000 --> 00:00:02,000"), "{text}");
    assert!(text.contains("Olá, mundo"), "{text}");
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
