import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startFixtureServer } from './fixture-server.mjs';

const EXTENSION_PATH = path.resolve(fileURLToPath(import.meta.url), '../../.output/chrome-mv3');

let server, context, worker, extensionId, videoPage, userDataDir, downloadDir;

before(async () => {
  server = await startFixtureServer();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'md-e2e-'));
  downloadDir = await mkdtemp(path.join(tmpdir(), 'md-e2e-downloads-'));
  await mkdir(path.join(userDataDir, 'Default'));
  await writeFile(
    path.join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false } }),
  );
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    // UTF-8 locale so accented file names are valid on Linux, as on real desktops.
    env: { ...process.env, LANGUAGE: 'pt_BR', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;

  videoPage = await context.newPage();
  // Playwright intercepts downloads and renames them to GUIDs; restore Chrome's own behavior
  // (profile download folder + subfolders) so the test sees the exact path the extension asked for.
  const cdp = await context.newCDPSession(videoPage);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });

  await videoPage.goto(`${server.origin}/page.html`);
  await waitFor(async () => (await mediaOfTab(await videoTabId())).length >= 5);
});

after(async () => {
  await context?.close();
  await server?.close();
  for (const dir of [userDataDir, downloadDir]) if (dir) await rm(dir, { recursive: true, force: true });
});

test('detects media, hides HLS variants and segments, flags DRM', async () => {
  const tabId = await videoTabId();
  const media = await mediaOfTab(tabId);
  const byPath = Object.fromEntries(media.map(m => [new URL(m.url).pathname, m]));

  assert.equal(byPath['/videos/minha%20aula.mp4'].protection, 'clear');
  assert.equal(byPath['/drm/index.m3u8'].protection, 'protected');
  assert.equal(byPath['/curso/aula-01/master.m3u8'].variantKeys.length, 1);
  assert.equal(byPath['/curso/aula-01/720p/segment-1.m4s'], undefined);
  assert.equal(await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId), '4');
});

test('downloads a progressive video into the configured folder', async () => {
  const popup = await openPopupWithMediaOf(await videoTabId());
  await itemNamed(popup, 'minha aula.mp4').getByRole('button', { name: 'Baixar', exact: true }).click();

  await itemNamed(popup, 'minha aula.mp4').getByText('Concluído').waitFor();
  const [item] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }));
  assert.equal(item.state, 'complete');
  assert.match(item.filename, /Media Downloader[/\\]minha aula\.mp4$/);
  assert.equal(item.fileSize, 2 * 1024 * 1024);
  await popup.close();
});

test('explains hotlink-protected failures instead of failing silently', async () => {
  const popup = await openPopupWithMediaOf(await videoTabId());
  await itemNamed(popup, 'protegido.mp4').getByRole('button', { name: 'Baixar', exact: true }).click();

  await itemNamed(popup, 'protegido.mp4').getByRole('alert').filter({ hasText: 'proteção contra hotlink' }).waitFor();
  await popup.close();
});

test('never offers or performs downloads of DRM content', async () => {
  const popup = await openPopupWithMediaOf(await videoTabId());
  const drmItem = itemNamed(popup, 'drm/index.m3u8');
  await drmItem.getByText('Por lei, não pode ser baixado').waitFor();
  assert.equal(await drmItem.getByRole('button').count(), 0);

  // Even a forged message straight to the background must be refused.
  const tabId = await popup.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  const media = await mediaOfTab(tabId);
  const drmKey = media.find(m => m.url.includes('/drm/')).key;
  const direct = await popup.evaluate(([id, key]) => chrome.runtime.sendMessage({ type: 'download', tabId: id, mediaKey: key }), [tabId, drmKey]);
  assert.deepEqual(direct, { ok: false, reason: 'protected' });
  await popup.close();
});

test('options page sanitizes and applies the destination folder', async () => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const folder = options.getByLabel('Pasta de destino');
  await folder.fill('../Cursos//Rust: avançado');
  await options.getByRole('button', { name: 'Salvar' }).click();
  await options.getByRole('status').waitFor();
  assert.equal(await folder.inputValue(), 'Cursos/Rust_ avançado');
  await options.close();

  const popup = await openPopupWithMediaOf(await videoTabId());
  await itemNamed(popup, 'minha aula.mp4').getByRole('button', { name: 'Baixar', exact: true }).click();
  await itemNamed(popup, 'minha aula.mp4').getByText('Concluído').waitFor();
  const [item] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }));
  assert.match(item.filename, /Cursos[/\\]Rust_ avançado[/\\]minha aula\.mp4$/);
  await popup.close();
});

test('clears the list when the tab navigates away', async () => {
  const tabId = await videoTabId();
  await videoPage.goto(`${server.origin}/empty.html`);
  await waitFor(async () => (await mediaOfTab(tabId)).length === 0);
});

// The popup lists the media of the active tab; opened as a page it is its own active tab,
// so the media detected on the video tab is copied to the popup's tab id.
async function openPopupWithMediaOf(sourceTabId) {
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const popupTabId = await popup.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  const media = await mediaOfTab(sourceTabId);
  await worker.evaluate(([key, list]) => chrome.storage.session.set({ [key]: list }), [`tab-media:${popupTabId}`, media]);
  await popup.locator('.item').first().waitFor();
  return popup;
}

const itemNamed = (page, name) => page.locator('.item').filter({ has: page.locator('.item__name', { hasText: name }) });

async function videoTabId() {
  return worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url?.startsWith(url))?.id, server.origin);
}

async function mediaOfTab(tabId) {
  const key = `tab-media:${tabId}`;
  return (await worker.evaluate(k => chrome.storage.session.get(k), key))[key] ?? [];
}

async function waitFor(condition, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
}
