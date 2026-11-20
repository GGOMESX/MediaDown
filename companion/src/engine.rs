use serde::Deserialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::protocol::ErrorCode;

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Quality {
    Best,
    MaxHeight { height: u32 },
    AudioMp3,
}

pub const MIN_HEIGHT: u32 = 144;
pub const MAX_HEIGHT: u32 = 4320;

impl Quality {
    pub fn is_valid(self) -> bool {
        match self {
            Quality::MaxHeight { height } => (MIN_HEIGHT..=MAX_HEIGHT).contains(&height),
            _ => true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EnginePaths {
    pub yt_dlp: PathBuf,
    pub ffmpeg_dir: PathBuf,
}

impl EnginePaths {
    /// Engines live in `bin\` next to the host executable; env vars override for tests.
    pub fn discover() -> Self {
        let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)).unwrap_or_default();
        let bin = exe_dir.join("bin");
        let yt_dlp_name = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
        Self {
            yt_dlp: std::env::var_os("MEDIADOWN_YTDLP").map(PathBuf::from).unwrap_or_else(|| bin.join(yt_dlp_name)),
            ffmpeg_dir: std::env::var_os("MEDIADOWN_FFMPEG_DIR").map(PathBuf::from).unwrap_or(bin),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.yt_dlp.is_file()
    }
}

pub struct DownloadSpec<'a> {
    pub url: &'a str,
    pub referer: Option<&'a str>,
    pub user_agent: Option<&'a str>,
    pub output_dir: &'a Path,
    /// Already sanitized and escaped for the output template.
    pub output_stem: &'a str,
    pub quality: Quality,
    pub subtitles: bool,
}

const PROGRESS_MARKER: &str = "MDPROG";
const DONE_MARKER: &str = "MDDONE";

pub fn build_args(spec: &DownloadSpec, engines: &EnginePaths) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        // A user or system yt-dlp config could inject options such as --exec: ignore them all.
        "--ignore-config",
        "--no-playlist",
        "--windows-filenames",
        "--encoding",
        "utf-8",
        "--newline",
        "--progress",
        "--color",
        "never",
        "--progress-template",
        "download:MDPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s",
        "--print",
        "after_move:MDDONE %(filepath)s",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();

    args.push("--ffmpeg-location".into());
    args.push(engines.ffmpeg_dir.clone().into());
    args.push("-P".into());
    args.push(spec.output_dir.into());
    args.push("-o".into());
    args.push(format!("{}.%(ext)s", spec.output_stem).into());

    if let Some(referer) = spec.referer {
        args.push("--add-headers".into());
        args.push(format!("Referer:{referer}").into());
    }
    if let Some(user_agent) = spec.user_agent {
        args.push("--add-headers".into());
        args.push(format!("User-Agent:{user_agent}").into());
    }

    args.extend(quality_args(spec.quality));
    if spec.subtitles && spec.quality != Quality::AudioMp3 {
        // Written next to the video as <name>.<lang>.srt, which every player picks up.
        args.extend(["--write-subs", "--sub-langs", "all,-live_chat", "--convert-subs", "srt"].map(OsString::from));
    }
    // Everything after "--" is a URL, never an option, even if it starts with "-".
    args.push("--".into());
    args.push(spec.url.into());
    args
}

fn quality_args(quality: Quality) -> Vec<OsString> {
    let args: Vec<String> = match quality {
        Quality::Best => vec!["-f".into(), "bv*+ba/b".into(), "--merge-output-format".into(), "mp4".into()],
        Quality::MaxHeight { height } => vec![
            "-f".into(),
            // Best at or below the limit; if nothing is that small, the smallest available.
            format!("bv*[height<={height}]+ba/b[height<={height}]/wv*+ba/w"),
            "--merge-output-format".into(),
            "mp4".into(),
        ],
        Quality::AudioMp3 => vec!["-f".into(), "ba/b".into(), "-x".into(), "--audio-format".into(), "mp3".into()],
    };
    args.into_iter().map(OsString::from).collect()
}

#[derive(Debug, PartialEq)]
pub enum EngineLine {
    Progress { downloaded_bytes: Option<u64>, total_bytes: Option<u64>, speed: Option<f64>, eta_seconds: Option<u64> },
    Done { path: PathBuf },
}

pub fn parse_line(line: &str) -> Option<EngineLine> {
    let line = line.trim_end_matches(['\r', '\n']);
    if let Some(rest) = line.strip_prefix(DONE_MARKER) {
        let path = rest.trim_start();
        return (!path.is_empty()).then(|| EngineLine::Done { path: PathBuf::from(path) });
    }

    let mut fields = line.trim_start().strip_prefix(PROGRESS_MARKER)?.split_whitespace();
    let downloaded = fields.next().and_then(parse_number);
    let total = fields.next().and_then(parse_number);
    let estimate = fields.next().and_then(parse_number);
    let speed = fields.next().and_then(parse_number);
    let eta = fields.next().and_then(parse_number);

    Some(EngineLine::Progress {
        downloaded_bytes: downloaded.map(|n| n as u64),
        total_bytes: total.or(estimate).map(|n| n as u64),
        speed,
        eta_seconds: eta.map(|n| n as u64),
    })
}

fn parse_number(raw: &str) -> Option<f64> {
    raw.parse::<f64>().ok().filter(|n| n.is_finite() && *n >= 0.0)
}

/// Maps yt-dlp's stderr to the few cases the user can act on.
pub fn classify_error(stderr: &str) -> ErrorCode {
    let text = stderr.to_ascii_lowercase();
    if text.contains("drm") {
        ErrorCode::Drm
    } else if text.contains("http error 403") || text.contains("http error 401") {
        ErrorCode::Forbidden
    } else if text.contains("http error 404") || text.contains("http error 410") {
        ErrorCode::Expired
    } else if text.contains("no space left") || text.contains("errno 28") || text.contains("not enough space") {
        ErrorCode::DiskFull
    } else if ["timed out", "connection", "network", "getaddrinfo", "unable to download"].iter().any(|k| text.contains(k)) {
        ErrorCode::Network
    } else {
        ErrorCode::Unknown
    }
}

/// Maps ffmpeg's stderr (used for live recording) to user-actionable codes.
pub fn classify_ffmpeg_error(stderr: &str) -> ErrorCode {
    let text = stderr.to_ascii_lowercase();
    if text.contains("not on whitelist") {
        ErrorCode::InvalidRequest
    } else if text.contains("403") || text.contains("401") {
        ErrorCode::Forbidden
    } else if text.contains("404") || text.contains("410") {
        ErrorCode::Expired
    } else if text.contains("no space left") {
        ErrorCode::DiskFull
    } else if ["connection", "timed out", "resolve", "network", "i/o error"].iter().any(|k| text.contains(k)) {
        ErrorCode::Network
    } else {
        ErrorCode::Unknown
    }
}

/// Last meaningful "ERROR:" line, trimmed for display; avoids sending whole tracebacks to the UI.
pub fn error_detail(stderr: &str) -> String {
    let line = stderr.lines().rev().find(|l| l.contains("ERROR:")).or_else(|| stderr.lines().rev().find(|l| !l.trim().is_empty()));
    line.unwrap_or_default().trim().chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engines() -> EnginePaths {
        EnginePaths { yt_dlp: "yt-dlp".into(), ffmpeg_dir: "bin".into() }
    }

    fn spec(quality: Quality) -> DownloadSpec<'static> {
        DownloadSpec {
            url: "https://cdn.example.com/aula/master.m3u8",
            referer: Some("https://example.com/aula"),
            user_agent: Some("Mozilla/5.0"),
            output_dir: Path::new("Downloads/Media Downloader"),
            output_stem: "Aula 1",
            quality,
            subtitles: false,
        }
    }

    fn as_strings(args: Vec<OsString>) -> Vec<String> {
        args.into_iter().map(|a| a.into_string().unwrap()).collect()
    }

    #[test]
    fn url_comes_last_after_the_option_terminator() {
        let args = as_strings(build_args(&spec(Quality::Best), &engines()));
        assert_eq!(&args[args.len() - 2..], ["--", "https://cdn.example.com/aula/master.m3u8"]);
    }

    #[test]
    fn ignores_user_config_and_never_allows_drm_formats() {
        let args = as_strings(build_args(&spec(Quality::Best), &engines()));
        assert_eq!(args[0], "--ignore-config");
        assert!(!args.iter().any(|a| a.contains("allow-unplayable") || a.contains("cookies") || a == "--exec"));
    }

    #[test]
    fn passes_output_location_and_headers() {
        let args = as_strings(build_args(&spec(Quality::Best), &engines()));
        let joined = args.join(" ");
        assert!(joined.contains("-P Downloads/Media Downloader -o Aula 1.%(ext)s"));
        assert!(joined.contains("--add-headers Referer:https://example.com/aula"));
        assert!(joined.contains("--add-headers User-Agent:Mozilla/5.0"));
        assert!(joined.contains("--ffmpeg-location bin"));
    }

    #[test]
    fn omits_headers_that_were_not_provided() {
        let mut no_headers = spec(Quality::Best);
        no_headers.referer = None;
        no_headers.user_agent = None;
        assert!(!as_strings(build_args(&no_headers, &engines())).contains(&"--add-headers".to_owned()));
    }

    #[test]
    fn presets_select_formats() {
        let audio = as_strings(build_args(&spec(Quality::AudioMp3), &engines())).join(" ");
        assert!(audio.contains("-x --audio-format mp3"));
        let hd = as_strings(build_args(&spec(Quality::MaxHeight { height: 720 }), &engines())).join(" ");
        assert!(hd.contains("-f bv*[height<=720]+ba/b[height<=720]/wv*+ba/w --merge-output-format mp4"));
    }

    #[test]
    fn validates_height_limits() {
        assert!(Quality::MaxHeight { height: 1080 }.is_valid());
        assert!(!Quality::MaxHeight { height: 0 }.is_valid());
        assert!(!Quality::MaxHeight { height: 99_999 }.is_valid());
        assert!(Quality::Best.is_valid());
    }

    #[test]
    fn requests_srt_subtitles_only_when_asked_and_not_for_audio() {
        let mut with_subs = spec(Quality::Best);
        with_subs.subtitles = true;
        let joined = as_strings(build_args(&with_subs, &engines())).join(" ");
        assert!(joined.contains("--write-subs --sub-langs all,-live_chat --convert-subs srt"));

        assert!(!as_strings(build_args(&spec(Quality::Best), &engines())).contains(&"--write-subs".to_owned()));

        let mut audio = spec(Quality::AudioMp3);
        audio.subtitles = true;
        assert!(!as_strings(build_args(&audio, &engines())).contains(&"--write-subs".to_owned()));
    }

    #[test]
    fn parses_progress_lines() {
        assert_eq!(
            parse_line("MDPROG 1048576 4194304 NA 524288.5 6\r\n"),
            Some(EngineLine::Progress { downloaded_bytes: Some(1_048_576), total_bytes: Some(4_194_304), speed: Some(524_288.5), eta_seconds: Some(6) })
        );
    }

    #[test]
    fn falls_back_to_estimated_total_for_streams() {
        let Some(EngineLine::Progress { total_bytes, .. }) = parse_line("  MDPROG 100 NA 9000.4 NA NA") else { panic!() };
        assert_eq!(total_bytes, Some(9000));
    }

    #[test]
    fn parses_final_path_with_spaces_and_accents() {
        assert_eq!(
            parse_line("MDDONE C:\\Users\\Ana\\Downloads\\Media Downloader\\Aula 1 — Introdução.mp4"),
            Some(EngineLine::Done { path: PathBuf::from("C:\\Users\\Ana\\Downloads\\Media Downloader\\Aula 1 — Introdução.mp4") })
        );
    }

    #[test]
    fn ignores_other_output() {
        assert_eq!(parse_line("[hlsnative] Downloading m3u8 manifest"), None);
        assert_eq!(parse_line("MDDONE "), None);
    }

    #[test]
    fn classifies_engine_errors() {
        assert_eq!(classify_error("ERROR: [generic] This video is DRM protected"), ErrorCode::Drm);
        assert_eq!(classify_error("ERROR: unable to download video data: HTTP Error 403: Forbidden"), ErrorCode::Forbidden);
        assert_eq!(classify_error("ERROR: HTTP Error 404: Not Found"), ErrorCode::Expired);
        assert_eq!(classify_error("OSError: [Errno 28] No space left on device"), ErrorCode::DiskFull);
        assert_eq!(classify_error("ERROR: Read timed out"), ErrorCode::Network);
        assert_eq!(classify_error("ERROR: something new"), ErrorCode::Unknown);
    }

    #[test]
    fn classifies_ffmpeg_errors() {
        assert_eq!(classify_ffmpeg_error("Protocol 'file' not on whitelist 'http,https,tcp,tls'!"), ErrorCode::InvalidRequest);
        assert_eq!(classify_ffmpeg_error("Server returned 403 Forbidden (access denied)"), ErrorCode::Forbidden);
        assert_eq!(classify_ffmpeg_error("HTTP error 404 Not Found"), ErrorCode::Expired);
        assert_eq!(classify_ffmpeg_error("Connection refused"), ErrorCode::Network);
        assert_eq!(classify_ffmpeg_error("Invalid data found when processing input"), ErrorCode::Unknown);
    }

    #[test]
    fn extracts_last_error_line() {
        let stderr = "WARNING: x\nTraceback...\nERROR: HTTP Error 403: Forbidden\n  at somewhere";
        assert_eq!(error_detail(stderr), "ERROR: HTTP Error 403: Forbidden");
    }
}
