//! MediaDown native messaging host: receives download jobs from the browser extension
//! and runs yt-dlp + ffmpeg locally. stdout is the protocol channel; never print to it.

pub mod engine;
pub mod jobs;
pub mod platform;
pub mod protocol;
pub mod recorder;
pub mod recovery;
pub mod validation;
