// Full chain: Chromium → extension → native messaging → Rust host → yt-dlp/ffmpeg → file on disk.
// Opt-in: needs MEDIADOWN_TEST_YTDLP and MEDIADOWN_TEST_FFMPEG_DIR, plus the host built with `cargo build`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(HERE, '../.output/chrome-mv3');
const HOST_BINARY = path.resolve(HERE, '../../companion/target/debug/mediadown-host');
const EXTENSION_ID = 'jakijlbgipgbbaldfhhpglollgnldckh';
const { MEDIADOWN_TEST_YTDLP: YTDLP, MEDIADOWN_TEST_FFMPEG_DIR: FFMPEG_DIR } = process.env;
const skip = !YTDLP || !FFMPEG_DIR || !existsSync(HOST_BINARY)
  ? 'needs MEDIADOWN_TEST_YTDLP, MEDIADOWN_TEST_FFMPEG_DIR and companion/target/debug/mediadown-host'
  : false;

let server, origin, context, worker, videoPage, dirs;

before(async () => {
  if (skip) return;
  dirs = {
    media: await mkdtemp(path.join(tmpdir(), 'md-media-')),
    profile: await mkdtemp(path.join(tmpdir(), 'md-profile-')),
    downloads: await mkdtemp(path.join(tmpdir(), 'md-downloads-')),
  };
  generateMedia(dirs.media);
  ({ server, origin } = await serve(dirs.media));

  await mkdir(path.join(dirs.profile, 'NativeMessagingHosts'));
  await writeFile(
    path.join(dirs.profile, 'NativeMessagingHosts', 'com.mediadown.host.json'),
    JSON.stringify({ name: 'com.mediadown.host', description: 'test', path: HOST_BINARY, type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }),
  );

  context = await chromium.launchPersistentContext(dirs.profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    env: {
      ...process.env,
      LANGUAGE: 'pt_BR',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      // Inherited by the native host that Chromium launches.
      MEDIADOWN_YTDLP: YTDLP,
      MEDIADOWN_FFMPEG_DIR: FFMPEG_DIR,
      MEDIADOWN_DOWNLOAD_DIR: dirs.downloads,
    },
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  assert.equal(new URL(worker.url()).host, EXTENSION_ID, 'manifest key must pin the extension id');

  videoPage = await context.newPage();
  await videoPage.goto(`${origin}/stream.html`);
  await waitFor(
    async () => (await mediaOf(await tabIdOf(origin))).some(m => m.url.includes('/hls/') && m.protection === 'clear'),
    15_000,
    async () => JSON.stringify(await mediaOf(await tabIdOf(origin))),
  );
});

after(async () => {
  await context?.close();
  server?.close();
  for (const dir of Object.values(dirs ?? {})) await rm(dir, { recursive: true, force: true });
});

test('popup reports the connected companion and its yt-dlp version', { skip }, async () => {
  const popup = await openPopupWith(await tabIdOf(origin));
  await popup.getByText(/App MediaDown conectado · yt-dlp 20\d\d\./).waitFor();
  const version = JSON.parse(await readFile(path.join(HERE, '../package.json'), 'utf8')).version;
  await popup.getByText(`Extensão ${version} · App ${version}`).waitFor();
  assert.equal(await popup.getByText('versões diferentes', { exact: false }).count(), 0);
  await popup.close();
});

test('downloads an HLS stream as MP4 named after the page', { skip }, async () => {
  const tabId = await tabIdOf(origin);
  const hls = (await mediaOf(tabId)).find(m => m.url.includes('/hls/index.m3u8'));
  const response = await sendFromExtension({ type: 'download', tabId, mediaKey: hls.key });
  assert.equal(response.via, 'companion');

  const job = await waitForJob(tabId, hls.key, 'done');
  assert.equal(job.fileName, 'Aula 7 — Introdução ao Rust.mp4');
  const file = await readFile(path.join(dirs.downloads, 'Media Downloader', job.fileName));
  assert.equal(file.subarray(4, 8).toString(), 'ftyp');
});

test('falls back to the companion for hotlink-protected files, sending the page as Referer', { skip }, async () => {
  const tabId = await tabIdOf(origin);
  const file = (await mediaOf(tabId)).find(m => m.url.includes('/hotlink/'));
  await sendFromExtension({ type: 'download', tabId, mediaKey: file.key, via: 'companion' });
  const job = await waitForJob(tabId, file.key, 'done');
  assert.ok(existsSync(path.join(dirs.downloads, 'Media Downloader', job.fileName)));
});

test('the popup button downloads a stream end to end', { skip }, async () => {
  const popup = await openPopupWith(await tabIdOf(origin));
  const item = popup.locator('.item').filter({ has: popup.locator('.item__name', { hasText: 'hls/index.m3u8' }) });
  await item.getByRole('button', { name: 'Baixar', exact: true }).click();
  await item.getByText('Concluído').waitFor({ timeout: 60_000 });
  await item.getByRole('button', { name: 'Mostrar na pasta' }).waitFor();
  // Set MEDIADOWN_E2E_SCREENSHOTS=<dir> to keep a picture of the finished state for review.
  if (process.env.MEDIADOWN_E2E_SCREENSHOTS) {
    await popup.screenshot({ path: path.join(process.env.MEDIADOWN_E2E_SCREENSHOTS, 'popup-companion.png') });
  }
  await popup.close();
});

test('the quality picker downloads the chosen resolution', { skip }, async () => {
  const tabId = await tabIdOf(origin);
  await waitFor(async () => (await mediaOf(tabId)).find(m => m.url.includes('/multi/'))?.heights?.length === 2);
  const popup = await openPopupWith(tabId);
  const item = popup.locator('.item').filter({ has: popup.locator('.item__name', { hasText: 'multi/master.m3u8' }) });
  const picker = item.getByRole('combobox', { name: 'Qualidade' });
  await picker.waitFor(); // shown once the popup knows the companion is ready
  assert.deepEqual(await picker.locator('option').allTextContents(), ['Melhor (240p)', 'Até 144p', 'Só áudio (MP3)']);

  await picker.selectOption({ label: 'Até 144p' });
  await item.getByRole('button', { name: 'Baixar', exact: true }).click();
  await item.getByText('Concluído').waitFor({ timeout: 60_000 });

  const popupTabId = await popup.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  const job = (await mediaOf(popupTabId)).find(m => m.url.includes('/multi/')).job;
  assert.equal(videoSize(path.join(dirs.downloads, 'Media Downloader', job.fileName)), '256x144');
  await popup.close();
});

test('records a live stream from the popup and saves it as MP4', { skip }, async () => {
  const tabId = await tabIdOf(origin);
  await waitFor(async () => (await mediaOf(tabId)).find(m => m.url.includes('/live/'))?.live === true);
  const popup = await openPopupWith(tabId);
  const item = popup.locator('.item').filter({ has: popup.locator('.item__name', { hasText: 'live/index.m3u8' }) });
  await item.getByText('Ao vivo', { exact: true }).waitFor();

  await item.getByRole('button', { name: 'Gravar' }).click();
  await item.getByText(/Gravando · 00:0[2-9]/).waitFor({ timeout: 30_000 });
  if (process.env.MEDIADOWN_E2E_SCREENSHOTS) {
    await popup.screenshot({ path: path.join(process.env.MEDIADOWN_E2E_SCREENSHOTS, 'popup-recording.png') });
  }
  await item.getByRole('button', { name: 'Parar e salvar' }).click();
  await item.getByText('Concluído').waitFor({ timeout: 30_000 });

  const popupTabId = await popup.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  const job = (await mediaOf(popupTabId)).find(m => m.url.includes('/live/')).job;
  assert.match(job.fileName, /— gravação \d{4}-\d{2}-\d{2} \d{2}h\d{2}\.mp4$/);
  const file = path.join(dirs.downloads, 'Media Downloader', job.fileName);
  assert.equal((await readFile(file)).subarray(4, 8).toString(), 'ftyp');
  assert.ok(mediaSeconds(file) >= 1.5, 'recorded at least the two seconds shown');
  await popup.close();
});

test('records a live stream at the resolution chosen in the popup', { skip }, async () => {
  const tabId = await tabIdOf(origin);
  await waitFor(async () => (await mediaOf(tabId)).find(m => m.url.includes('/livemaster/'))?.live === true, 20_000);
  const popup = await openPopupWith(tabId);
  const item = popup.locator('.item').filter({ has: popup.locator('.item__name', { hasText: 'livemaster/master.m3u8' }) });
  const picker = item.getByRole('combobox', { name: 'Qualidade' });
  await picker.waitFor();
  assert.deepEqual(await picker.locator('option').allTextContents(), ['Melhor (240p)', 'Até 144p']);

  await picker.selectOption({ label: 'Até 144p' });
  await item.getByRole('button', { name: 'Gravar' }).click();
  await item.getByText(/Gravando · 00:0[2-9]/).waitFor({ timeout: 30_000 });
  await item.getByRole('button', { name: 'Parar e salvar' }).click();
  await item.getByText('Concluído').waitFor({ timeout: 30_000 });

  const popupTabId = await popup.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  const job = (await mediaOf(popupTabId)).find(m => m.url.includes('/livemaster/')).job;
  assert.equal(videoSize(path.join(dirs.downloads, 'Media Downloader', job.fileName)), '256x144');
  await popup.close();
});

// ---------- helpers ----------

function mediaSeconds(file) {
  const ffmpeg = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  let info = '';
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: 'pipe' });
  } catch (error) {
    info = String(error.stderr);
  }
  const [h, m, s] = (info.match(/Duration: (\d+):(\d+):([\d.]+)/) ?? [0, 0, 0, 0]).slice(1).map(Number);
  return h * 3600 + m * 60 + s;
}

function generateMedia(dir) {
  const ffmpeg = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const source = ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=duration=3'];
  const encode = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
  const run = args => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: dir });
  execFileSync('mkdir', ['-p', path.join(dir, 'hls')]);
  run([...source, ...encode, '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', 'hls/index.m3u8']);
  run([...source, ...encode, '-movflags', '+faststart', 'real.mp4']);
  for (const [height, width] of [[240, 320], [144, 256]]) {
    execFileSync('mkdir', ['-p', path.join(dir, `multi/${height}`)]);
    run([...source, '-vf', `scale=${width}:${height}`, ...encode, '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', `multi/${height}/index.m3u8`]);
  }
  // 1-second segments with a keyframe each: served as a sliding live window.
  execFileSync('mkdir', ['-p', path.join(dir, 'live-src')]);
  run([
    '-f', 'lavfi', '-i', 'testsrc=duration=30:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=duration=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*1)', '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', 'live-src/seg%d.ts', 'live-src/vod.m3u8',
  ]);
  execFileSync('mkdir', ['-p', path.join(dir, 'live-src-144')]);
  run([
    '-f', 'lavfi', '-i', 'testsrc=duration=30:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=duration=30', '-vf', 'scale=256:144',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*1)', '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', 'live-src-144/seg%d.ts', 'live-src-144/vod.m3u8',
  ]);
  execFileSync('sh', ['-c', `printf '%s' "$0" > multi/master.m3u8`, [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=320x240', '240/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=256x144', '144/index.m3u8', '',
  ].join('\n')], { cwd: dir });
}

function videoSize(file) {
  const ffmpeg = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  let info = '';
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: 'pipe' });
  } catch (error) {
    info = String(error.stderr); // ffmpeg exits non-zero without an output file, after printing stream info
  }
  return info.match(/Video:.*?\b(\d{2,5}x\d{2,5})\b/)?.[1];
}

async function serve(root) {
  const page = `<!doctype html><title>Aula 7 — Introdução ao Rust</title>
    <video src="/hotlink/real.mp4" preload="auto" muted></video>
    <script>fetch('/hls/index.m3u8'); fetch('/multi/master.m3u8'); fetch('/live/index.m3u8'); fetch('/livemaster/master.m3u8')</script>`;
  const liveMaster = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=320x240\n240/index.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=256x144\n144/index.m3u8\n';
  const liveSources = { '/live/': 'live-src', '/livemaster/240/': 'live-src', '/livemaster/144/': 'live-src-144' };
  const started = Date.now();
  // A live playlist as published `elapsed` seconds in: a 3-segment window advancing every second, no ENDLIST.
  const livePlaylist = () => {
    const newest = Math.min(Math.floor((Date.now() - started) / 1000) + 3, 30);
    const first = newest - 3;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${first}`];
    for (let i = first; i < newest; i++) lines.push('#EXTINF:1.0,', `seg${i}.ts`);
    return lines.join('\n') + '\n';
  };
  const types = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/stream.html') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
    if (url.pathname === '/livemaster/master.m3u8') {
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(liveMaster);
    }
    const liveDir = Object.keys(liveSources).find(prefix => url.pathname.startsWith(prefix) && url.pathname.slice(prefix.length).match(/^(index\.m3u8|seg\d+\.ts)$/));
    if (liveDir && url.pathname.endsWith('index.m3u8')) {
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache' }).end(livePlaylist());
    }
    if (liveDir) {
      const body = await readFile(path.join(root, liveSources[liveDir], path.basename(url.pathname))).catch(() => null);
      return body ? res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': body.length }).end(body) : res.writeHead(404).end();
    }
    const hotlink = url.pathname.startsWith('/hotlink/');
    if (hotlink && !req.headers.referer) return res.writeHead(403).end();
    const relative = hotlink ? url.pathname.slice('/hotlink/'.length) : url.pathname.slice(1);
    try {
      const body = await readFile(path.join(root, path.normalize(relative).replace(/^(\.\.[/\\])+/, '')));
      res.writeHead(200, { 'content-type': types[path.extname(relative)] ?? 'application/octet-stream', 'content-length': body.length }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function sendFromExtension(message) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  const response = await page.evaluate(m => chrome.runtime.sendMessage(m), message);
  await page.close();
  return response;
}

async function openPopupWith(sourceTabId) {
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  const popupTabId = await popup.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  const media = (await mediaOf(sourceTabId)).map(({ job, downloadId, ...rest }) => rest);
  await worker.evaluate(([key, list]) => chrome.storage.session.set({ [key]: list }), [`tab-media:${popupTabId}`, media]);
  await popup.locator('.item').first().waitFor();
  return popup;
}

async function tabIdOf(prefix) {
  return worker.evaluate(async p => (await chrome.tabs.query({})).find(t => t.url?.startsWith(p))?.id, prefix);
}

async function mediaOf(tabId) {
  const key = `tab-media:${tabId}`;
  return (await worker.evaluate(k => chrome.storage.session.get(k), key))[key] ?? [];
}

async function waitForJob(tabId, mediaKey, state) {
  let job;
  await waitFor(async () => {
    job = (await mediaOf(tabId)).find(m => m.key === mediaKey)?.job;
    if (job?.state === 'failed' && state !== 'failed') throw new Error(`job failed: ${JSON.stringify(job)}`);
    return job?.state === state;
  }, 60_000);
  return job;
}

async function waitFor(condition, timeoutMs = 15_000, describe = async () => '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for condition ${await describe()}`);
}
