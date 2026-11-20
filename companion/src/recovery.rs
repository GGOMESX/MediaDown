//! Recovers recordings interrupted without a clean stop (browser killed, crash, power loss).
//!
//! Each active recording has a small marker file in the state directory, held under an
//! exclusive OS lock for as long as its host process lives. The OS drops the lock when the
//! process dies, however it dies, so "marker whose lock can be taken" means "orphaned
//! recording". Several hosts may run at once (Chrome and Edge each start one), and the lock
//! keeps one host from touching a recording another is still writing.

use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions, TryLockError};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::recorder;

const MARKER_PREFIX: &str = "recording-";
const MARKER_EXTENSION: &str = "json";

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Marker {
    ts: PathBuf,
    mp4: PathBuf,
}

/// Holds the lock that marks a recording as alive; dropping it (or the process dying) releases it.
pub struct ActiveRecording {
    file: Option<File>,
    path: PathBuf,
}

impl ActiveRecording {
    /// Clean end: the watcher already produced the final file.
    pub fn finish(mut self) {
        self.file.take(); // closes the handle and releases the lock before deleting (required on Windows)
        let _ = std::fs::remove_file(&self.path);
    }
}

pub fn state_dir() -> PathBuf {
    std::env::var_os("MEDIADOWN_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::data_local_dir().map(|dir| dir.join("MediaDown").join("recordings")))
        .unwrap_or_else(|| std::env::temp_dir().join("MediaDown").join("recordings"))
}

pub fn register(state_dir: &Path, ts: &Path, mp4: &Path) -> io::Result<ActiveRecording> {
    std::fs::create_dir_all(state_dir)?;
    let path = state_dir.join(unique_marker_name());
    let mut file = OpenOptions::new().read(true).write(true).create_new(true).open(&path)?;
    file.lock()?;
    file.write_all(&serde_json::to_vec(&Marker { ts: ts.to_owned(), mp4: mp4.to_owned() })?)?;
    file.flush()?;
    Ok(ActiveRecording { file: Some(file), path })
}

/// Converts every orphaned recording to MP4 (or leaves the playable TS if that fails).
/// Returns the files it finalized.
pub fn recover_orphans(state_dir: &Path, ffmpeg: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(state_dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_marker(path))
        .filter_map(|path| recover_one(&path, ffmpeg))
        .collect()
}

fn recover_one(marker_path: &Path, ffmpeg: &Path) -> Option<PathBuf> {
    let mut file = OpenOptions::new().read(true).open(marker_path).ok()?;
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return None, // still being recorded by a live host
        Err(TryLockError::Error(_)) => return None,
    }

    let mut contents = Vec::new();
    let marker: Option<Marker> = file.read_to_end(&mut contents).ok().and_then(|_| serde_json::from_slice(&contents).ok());
    let recovered = marker.and_then(|marker| {
        let has_data = std::fs::metadata(&marker.ts).is_ok_and(|m| m.len() > 0);
        has_data.then(|| recorder::finalize(ffmpeg, &marker.ts, &marker.mp4))
    });

    drop(file);
    let _ = std::fs::remove_file(marker_path);
    recovered
}

fn is_marker(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    name.starts_with(MARKER_PREFIX) && path.extension().is_some_and(|ext| ext == MARKER_EXTENSION)
}

fn unique_marker_name() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    format!("{MARKER_PREFIX}{}-{nanos}-{}.{MARKER_EXTENSION}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finished_recording_leaves_no_marker() {
        let state = tempfile::tempdir().unwrap();
        let active = register(state.path(), Path::new("a.ts"), Path::new("a.mp4")).unwrap();
        assert_eq!(std::fs::read_dir(state.path()).unwrap().count(), 1);
        active.finish();
        assert_eq!(std::fs::read_dir(state.path()).unwrap().count(), 0);
    }

    #[test]
    fn markers_of_live_recordings_are_left_alone() {
        let state = tempfile::tempdir().unwrap();
        let media = tempfile::tempdir().unwrap();
        let ts = media.path().join("live.ts");
        std::fs::write(&ts, b"still being written").unwrap();
        let active = register(state.path(), &ts, &media.path().join("live.mp4")).unwrap();

        assert!(recover_orphans(state.path(), Path::new("no-ffmpeg-needed")).is_empty());
        assert!(ts.exists(), "a recording in progress must never be touched");
        assert_eq!(std::fs::read_dir(state.path()).unwrap().count(), 1);
        active.finish();
    }

    #[test]
    fn orphans_without_data_are_cleaned_up() {
        let state = tempfile::tempdir().unwrap();
        let marker = state.path().join("recording-1-2-3.json");
        std::fs::write(&marker, br#"{"ts":"/nonexistent/x.ts","mp4":"/nonexistent/x.mp4"}"#).unwrap();
        assert!(recover_orphans(state.path(), Path::new("ffmpeg")).is_empty());
        assert!(!marker.exists());
    }

    #[test]
    fn ignores_unrelated_files_and_missing_dirs() {
        let state = tempfile::tempdir().unwrap();
        std::fs::write(state.path().join("notes.txt"), b"x").unwrap();
        assert!(recover_orphans(state.path(), Path::new("ffmpeg")).is_empty());
        assert!(state.path().join("notes.txt").exists());
        assert!(recover_orphans(&state.path().join("missing"), Path::new("ffmpeg")).is_empty());
    }
}
