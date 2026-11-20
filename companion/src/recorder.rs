//! Live stream recording with ffmpeg.
//!
//! Recording goes to MPEG-TS first: a TS file stays playable even if the process is killed
//! mid-write (browser closed, power loss). A clean stop sends `q` on ffmpeg's stdin, which
//! works the same on Windows (no signals involved); the TS is then remuxed to MP4.

use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const DEFAULT_MAX_SECONDS: u64 = 6 * 60 * 60;
pub const DEFAULT_MIN_FREE_BYTES: u64 = 500 * 1024 * 1024;
/// Only network protocols: a hostile playlist must not make ffmpeg read local files (file://).
const PROTOCOL_WHITELIST: &str = "http,https,tcp,tls";

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    DiskFull,
    MaxDuration,
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_seconds: u64,
    pub min_free_bytes: u64,
}

impl Limits {
    /// Env overrides exist for tests only (a 6-hour or disk-full scenario is not testable otherwise).
    pub fn from_env() -> Self {
        let read = |name: &str, default: u64| std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default);
        Self {
            max_seconds: read("MEDIADOWN_MAX_RECORDING_SECONDS", DEFAULT_MAX_SECONDS),
            min_free_bytes: read("MEDIADOWN_MIN_FREE_BYTES", DEFAULT_MIN_FREE_BYTES),
        }
    }
}

pub struct RecordSpec<'a> {
    pub url: &'a str,
    pub referer: Option<&'a str>,
    pub user_agent: Option<&'a str>,
    pub output: &'a Path,
    pub max_seconds: u64,
}

pub fn record_args(spec: &RecordSpec) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-nostats", "-loglevel", "error", "-y", "-protocol_whitelist", PROTOCOL_WHITELIST]
        .map(OsString::from)
        .to_vec();
    if let Some(user_agent) = spec.user_agent {
        args.extend(["-user_agent".into(), user_agent.into()]);
    }
    if let Some(referer) = spec.referer {
        args.extend(["-referer".into(), referer.into()]);
    }
    args.extend(["-i".into(), spec.url.into()]);
    // Default stream selection keeps one video (highest resolution) and one audio track;
    // subtitles and timed-ID3 data would break the TS/MP4 muxers.
    args.extend(["-sn", "-dn", "-c", "copy", "-t"].map(OsString::from));
    args.push(spec.max_seconds.to_string().into());
    args.extend(["-f", "mpegts", "-progress", "pipe:1"].map(OsString::from));
    args.push(spec.output.into());
    args
}

pub fn remux_args(input: &Path, output: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i"].map(OsString::from).to_vec();
    args.push(input.into());
    args.extend(["-map", "0:v?", "-map", "0:a?", "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart"].map(OsString::from));
    args.push(output.into());
    args
}

/// `<stem>.<ext>`, or `<stem> (2).<ext>`, ... so a new recording never overwrites an old one.
/// Both the TS and the final MP4 name must be free.
pub fn unique_paths(dir: &Path, stem: &str) -> (PathBuf, PathBuf) {
    (1..)
        .map(|n| if n == 1 { stem.to_owned() } else { format!("{stem} ({n})") })
        .map(|name| (dir.join(format!("{name}.ts")), dir.join(format!("{name}.mp4"))))
        .find(|(ts, mp4)| !ts.exists() && !mp4.exists())
        .expect("an unused name always exists")
}

#[derive(Debug, Default, PartialEq, Eq, Clone, Copy)]
pub struct RecordProgress {
    pub bytes: Option<u64>,
    pub elapsed_seconds: Option<u64>,
}

/// Accumulates ffmpeg `-progress` key=value lines; a block ends with `progress=continue|end`.
#[derive(Default)]
pub struct ProgressParser {
    current: RecordProgress,
}

impl ProgressParser {
    pub fn feed(&mut self, line: &str) -> Option<RecordProgress> {
        let (key, value) = line.trim().split_once('=')?;
        match key {
            "total_size" => self.current.bytes = value.parse().ok(),
            "out_time_us" | "out_time_ms" => {
                // Despite its name, out_time_ms is also in microseconds.
                if let Ok(micros) = value.parse::<u64>() {
                    self.current.elapsed_seconds = Some(micros / 1_000_000);
                }
            }
            "progress" => return Some(self.current),
            _ => {}
        }
        None
    }
}

pub fn free_space(path: &Path) -> Option<u64> {
    fs4::available_space(path).ok()
}

pub fn ffmpeg_binary(dir: &Path) -> PathBuf {
    dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: Vec<OsString>) -> Vec<String> {
        args.into_iter().map(|a| a.into_string().unwrap()).collect()
    }

    fn spec(output: &Path) -> RecordSpec<'_> {
        RecordSpec {
            url: "https://live.example.com/canal/index.m3u8",
            referer: Some("https://example.com/ao-vivo"),
            user_agent: Some("Mozilla/5.0"),
            output,
            max_seconds: 21600,
        }
    }

    #[test]
    fn restricts_protocols_before_the_input() {
        let args = strings(record_args(&spec(Path::new("out.ts"))));
        let whitelist = args.iter().position(|a| a == "-protocol_whitelist").unwrap();
        let input = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(args[whitelist + 1], "http,https,tcp,tls");
        assert!(whitelist < input, "input options must come before -i");
        assert!(!args.iter().any(|a| a.contains("file") || a.contains("crypto")));
    }

    #[test]
    fn sends_headers_copies_streams_and_caps_duration() {
        let joined = strings(record_args(&spec(Path::new("out.ts")))).join(" ");
        assert!(joined.contains("-user_agent Mozilla/5.0 -referer https://example.com/ao-vivo -i https://live.example.com/canal/index.m3u8"));
        assert!(joined.contains("-sn -dn -c copy -t 21600 -f mpegts -progress pipe:1 out.ts"));
        assert!(!joined.contains("-nostdin"), "stdin must stay open: it carries the stop command");
    }

    #[test]
    fn remux_keeps_only_audio_and_video_and_ignores_stdin() {
        let joined = strings(remux_args(Path::new("a.ts"), Path::new("a.mp4"))).join(" ");
        assert!(joined.contains("-nostdin"));
        assert!(joined.contains("-i a.ts -map 0:v? -map 0:a? -c copy -bsf:a aac_adtstoasc -movflags +faststart a.mp4"));
    }

    #[test]
    fn picks_unused_names() {
        let dir = tempfile::tempdir().unwrap();
        let (ts, mp4) = unique_paths(dir.path(), "Live");
        assert_eq!((ts.file_name().unwrap(), mp4.file_name().unwrap()), ("Live.ts".as_ref(), "Live.mp4".as_ref()));

        std::fs::write(dir.path().join("Live.mp4"), b"x").unwrap();
        std::fs::write(dir.path().join("Live (2).ts"), b"x").unwrap();
        let (ts, mp4) = unique_paths(dir.path(), "Live");
        assert_eq!(ts.file_name().unwrap(), "Live (3).ts");
        assert_eq!(mp4.file_name().unwrap(), "Live (3).mp4");
    }

    #[test]
    fn parses_progress_blocks() {
        let mut parser = ProgressParser::default();
        let lines = ["frame=75", "total_size=524288", "out_time_us=3040000", "out_time=00:00:03.040000", "speed=1.0x"];
        assert!(lines.iter().all(|l| parser.feed(l).is_none()));
        assert_eq!(parser.feed("progress=continue"), Some(RecordProgress { bytes: Some(524_288), elapsed_seconds: Some(3) }));
    }

    #[test]
    fn tolerates_unavailable_values() {
        let mut parser = ProgressParser::default();
        parser.feed("total_size=N/A");
        parser.feed("out_time_us=N/A");
        assert_eq!(parser.feed("progress=continue"), Some(RecordProgress::default()));
        assert_eq!(parser.feed("garbage without equals"), None);
    }

    #[test]
    fn reports_free_space_for_existing_dirs() {
        assert!(free_space(&std::env::temp_dir()).unwrap() > 0);
    }
}
