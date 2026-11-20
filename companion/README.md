# MediaDown companion (Windows)

Native messaging host in Rust. The extension sends it download jobs; it runs
**yt-dlp + ffmpeg locally** and reports progress back. It covers what the browser
alone cannot do: HLS/DASH streams, merging audio and video, MP3 extraction, and
files that require a `Referer` (hotlink protection).

## Installation (end user)

1. Download the `MediaDown-companion-windows` artifact from the latest successful
   CI run (Actions → CI → Artifacts) and extract it.
2. Double-click `install.cmd`. No administrator rights are needed: everything goes to
   `%LOCALAPPDATA%\MediaDown` and `HKCU`.
3. Reload the extension in `chrome://extensions`. The popup footer should read
   "App MediaDown conectado".

To remove: `uninstall.cmd`. Downloaded videos are not touched.

## Architecture

```
extension (service worker) ──connectNative──► mediadown-host.exe
        ▲   JSON, 4-byte length prefix (stdin/stdout)   │
        └──────── queued / started / progress / done / failed
                                                         ▼
                              yt-dlp.exe ──► ffmpeg.exe  (Job Object, no console window)
```

| Module | Responsibility |
|---|---|
| `protocol.rs` | Framing (64 KB in / 1 MB out limits), typed messages with `deny_unknown_fields`, protocol v2 |
| `validation.rs` | http/https URLs, header values without CR/LF, file and folder names safe on Windows, escaping `%` in the yt-dlp template |
| `engine.rs` | yt-dlp arguments (`--ignore-config`, `--` before the URL, quality `best`/`maxHeight`/`audioMp3`, subtitles as `.srt`), progress parsing and error classification |
| `jobs.rs` | Download queue (2 at a time), recordings beside it (up to 2), cancellation, clean stop, "show in folder" only for files the host created |
| `recovery.rs` | Markers of active recordings under an exclusive OS lock; at startup, orphaned recordings (lock free) are converted to MP4. Safe with several hosts at once (Chrome and Edge) |
| `recorder.rs` | Live recording with ffmpeg: `-protocol_whitelist http,https,tcp,tls`, MPEG-TS then MP4 remux, `-progress` parsing, unique names, 6 h cap and disk-space stop |
| `platform.rs` | Windows: Job Object `KILL_ON_JOB_CLOSE`, `CREATE_NO_WINDOW`, Explorer |

### Security decisions

- The browser only launches the host for the extension ID in `allowed_origins`
  (fixed by the `key` in the manifest).
- The host never receives a path from the extension: just a subfolder name, which
  is sanitized and confined to Downloads.
- `--ignore-config`: a yt-dlp config on the machine cannot inject `--exec`.
- Never `--allow-unplayable-formats` and never browser cookies. yt-dlp itself refuses DRM.
- Engines pinned by version and **SHA-256** in `installer/engines.json`. The installer
  aborts if any byte differs.
- Closing the browser ends the host (EOF on stdin), and the Job Object kills yt-dlp
  and ffmpeg along with it. Recordings first get up to 10 s to stop with `q` and become MP4.
  If they run out of time, the `.ts` file stays playable.
- Recordings stop cleanly with `q` on ffmpeg's stdin, which works on Windows (no signals).
  If ffmpeg doesn't respond within 15 s, the process tree is terminated.

## Development

```bash
cargo test                       # unit tests
cargo clippy --all-targets -- -D warnings
cargo check --target x86_64-pc-windows-gnu   # type-check the Windows code from Linux

# Integration tests with the real engines (optional; skipped without these variables):
MEDIADOWN_TEST_YTDLP=$(which yt-dlp) MEDIADOWN_TEST_FFMPEG_DIR=/usr/bin cargo test
```

Environment variables honored by the host (tests only): `MEDIADOWN_YTDLP`,
`MEDIADOWN_FFMPEG_DIR`, `MEDIADOWN_DOWNLOAD_DIR`, `MEDIADOWN_MAX_RECORDING_SECONDS`,
`MEDIADOWN_MIN_FREE_BYTES`, `MEDIADOWN_STATE_DIR`.

### Updating yt-dlp or ffmpeg

- **yt-dlp:** automatic. The `Update yt-dlp` workflow opens a weekly PR, verified
  against the official `SHA2-256SUMS`.
- **ffmpeg:** manual. Update the version, URL and SHA-256 values in
  `installer/engines.json`. Compute the hashes yourself from the official file;
  never copy them from a third party.
