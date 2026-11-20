use std::io::{self, BufWriter};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;

use mediadown_host::engine::EnginePaths;
use mediadown_host::jobs::{Config, JobManager, ManagerMsg};
use mediadown_host::protocol::{self, Event};
use mediadown_host::recorder::Limits;

const MAX_CONCURRENT_DOWNLOADS: usize = 2;

fn main() {
    let (event_tx, event_rx) = mpsc::channel::<Event>();
    let (manager_tx, manager_rx) = mpsc::channel::<ManagerMsg>();

    // Single writer thread: framed messages from several jobs must never interleave on stdout.
    let writer = thread::spawn(move || {
        let mut stdout = BufWriter::new(io::stdout().lock());
        for event in event_rx {
            // Browser gone: stop writing, but let the manager finish saving recordings.
            if protocol::write_event(&mut stdout, &event).is_err() {
                break;
            }
        }
    });

    let reader_tx = manager_tx.clone();
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        loop {
            let message = match protocol::read_message(&mut stdin) {
                Ok(Some(body)) => match protocol::parse_request(&body) {
                    Ok(request) => ManagerMsg::Request(request),
                    Err(detail) => ManagerMsg::Invalid(detail),
                },
                Ok(None) | Err(_) => ManagerMsg::Shutdown,
            };
            let shutting_down = matches!(message, ManagerMsg::Shutdown);
            if reader_tx.send(message).is_err() || shutting_down {
                return;
            }
        }
    });

    let config = Config {
        downloads_dir: downloads_dir(),
        engines: EnginePaths::discover(),
        max_concurrent: MAX_CONCURRENT_DOWNLOADS,
        recording_limits: Limits::from_env(),
    };
    JobManager::new(config, event_tx, manager_tx).run(manager_rx);
    let _ = writer.join();
}

fn downloads_dir() -> PathBuf {
    std::env::var_os("MEDIADOWN_DOWNLOAD_DIR")
        .map(PathBuf::from)
        .or_else(dirs::download_dir)
        .or_else(|| dirs::home_dir().map(|home| home.join("Downloads")))
        .unwrap_or_else(|| PathBuf::from("."))
}
