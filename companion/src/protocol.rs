use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

use crate::engine::Quality;
use crate::recorder::StopReason;

/// v2: `quality` (best / maxHeight / audioMp3) replaces `preset`; adds `subtitles`.
/// v3: live recording (`record` / `stop`), `elapsedSeconds` in progress, `stopReason` in done.
pub const PROTOCOL_VERSION: u32 = 3;
/// Chrome refuses host-to-browser messages above 1 MB.
const MAX_OUTGOING_BYTES: usize = 1024 * 1024;
/// Our requests are tiny; anything bigger is a bug or an attack.
const MAX_INCOMING_BYTES: u32 = 64 * 1024;

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Request {
    Hello { protocol_version: u32 },
    Download {
        job_id: String,
        url: String,
        referer: Option<String>,
        user_agent: Option<String>,
        folder: String,
        file_name: String,
        quality: Quality,
        subtitles: bool,
    },
    Record {
        job_id: String,
        url: String,
        referer: Option<String>,
        user_agent: Option<String>,
        folder: String,
        file_name: String,
    },
    /// Ends a recording cleanly and keeps what was recorded.
    Stop { job_id: String },
    Cancel { job_id: String },
    Reveal { job_id: String },
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    InvalidRequest,
    EngineMissing,
    Forbidden,
    Expired,
    Network,
    DiskFull,
    Drm,
    Canceled,
    /// Too many recordings at once.
    Busy,
    Unknown,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    Hello { protocol_version: u32, host_version: String, engine_ready: bool, engine_version: Option<String> },
    Queued { job_id: String },
    Started { job_id: String },
    Progress {
        job_id: String,
        downloaded_bytes: Option<u64>,
        total_bytes: Option<u64>,
        speed: Option<f64>,
        eta_seconds: Option<u64>,
        /// Recordings only: how much has been recorded so far.
        elapsed_seconds: Option<u64>,
    },
    Done { job_id: String, file_name: String, stop_reason: Option<StopReason> },
    Failed { job_id: String, error: ErrorCode, detail: String },
    InvalidRequest { detail: String },
}

/// Reads one length-prefixed message. Returns `Ok(None)` on clean EOF (browser closed the port).
pub fn read_message(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }

    let length = u32::from_ne_bytes(header);
    if length > MAX_INCOMING_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("message of {length} bytes exceeds limit")));
    }

    let mut body = vec![0u8; length as usize];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

pub fn write_event(writer: &mut impl Write, event: &Event) -> io::Result<()> {
    let body = serde_json::to_vec(event)?;
    if body.len() > MAX_OUTGOING_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "outgoing message too large"));
    }
    writer.write_all(&(body.len() as u32).to_ne_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
}

pub fn parse_request(body: &[u8]) -> Result<Request, String> {
    serde_json::from_slice(body).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn frame(json: &str) -> Vec<u8> {
        let mut bytes = (json.len() as u32).to_ne_bytes().to_vec();
        bytes.extend_from_slice(json.as_bytes());
        bytes
    }

    #[test]
    fn reads_consecutive_messages_then_reports_eof() {
        let mut input = Cursor::new([frame(r#"{"a":1}"#), frame(r#"{"b":2}"#)].concat());
        assert_eq!(read_message(&mut input).unwrap().unwrap(), br#"{"a":1}"#);
        assert_eq!(read_message(&mut input).unwrap().unwrap(), br#"{"b":2}"#);
        assert_eq!(read_message(&mut input).unwrap(), None);
    }

    #[test]
    fn rejects_oversized_messages_without_allocating_them() {
        let mut input = Cursor::new(u32::MAX.to_ne_bytes().to_vec());
        assert_eq!(read_message(&mut input).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn reports_truncated_body_as_error() {
        let mut bytes = 10u32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"abc");
        assert!(read_message(&mut Cursor::new(bytes)).is_err());
    }

    #[test]
    fn writes_length_prefixed_camel_case_json() {
        let mut output = Vec::new();
        write_event(&mut output, &Event::Queued { job_id: "j1".into() }).unwrap();
        let length = u32::from_ne_bytes(output[..4].try_into().unwrap()) as usize;
        assert_eq!(&output[4..], br#"{"type":"queued","jobId":"j1"}"#);
        assert_eq!(length, output.len() - 4);
    }

    #[test]
    fn parses_download_requests() {
        let request = parse_request(
            br#"{"type":"download","jobId":"j1","url":"https://c.example.com/a.m3u8","referer":"https://example.com/aula","userAgent":"UA","folder":"Media Downloader","fileName":"Aula 1","quality":{"mode":"maxHeight","height":720},"subtitles":true}"#,
        )
        .unwrap();
        assert!(matches!(request, Request::Download { quality: Quality::MaxHeight { height: 720 }, subtitles: true, .. }));
    }

    #[test]
    fn parses_record_and_stop_requests() {
        let record = parse_request(br#"{"type":"record","jobId":"r1","url":"https://live.example.com/i.m3u8","referer":null,"userAgent":"UA","folder":"","fileName":"Live"}"#);
        assert!(matches!(record, Ok(Request::Record { .. })));
        assert_eq!(parse_request(br#"{"type":"stop","jobId":"r1"}"#), Ok(Request::Stop { job_id: "r1".into() }));
    }

    #[test]
    fn serializes_stop_reasons() {
        let mut output = Vec::new();
        write_event(&mut output, &Event::Done { job_id: "r1".into(), file_name: "a.mp4".into(), stop_reason: Some(StopReason::DiskFull) }).unwrap();
        assert_eq!(&output[4..], br#"{"type":"done","jobId":"r1","fileName":"a.mp4","stopReason":"diskFull"}"#);
    }

    #[test]
    fn rejects_version_1_requests_with_preset() {
        let v1 = br#"{"type":"download","jobId":"j1","url":"https://c.example.com/a.m3u8","referer":null,"userAgent":null,"folder":"","fileName":"a","preset":"best"}"#;
        assert!(parse_request(v1).is_err());
    }

    #[test]
    fn rejects_unknown_fields_and_types() {
        assert!(parse_request(br#"{"type":"cancel","jobId":"j1","exec":"calc.exe"}"#).is_err());
        assert!(parse_request(br#"{"type":"shell","cmd":"calc.exe"}"#).is_err());
        assert!(parse_request(b"not json").is_err());
    }
}
