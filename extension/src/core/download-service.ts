import { browser } from 'wxt/browser';
import type { DownloadRequest, DownloadResponse, DownloadRefusal, CompanionState, RecordRequest } from './messages';
import type { DetectedMedia } from './media-classifier';
import type { CompanionGateway } from './companion-client';
import { readTabMedia, updateTabMedia } from './tab-media-store';
import { applyDownloadStarted } from './tab-media';
import { applyJobStarted, newJobId } from './companion-job';
import { loadSettings } from './settings';
import { buildDownloadPath, chooseBaseName, chooseStem, recordingStem, toAsciiPath } from './file-name';
import { presetToChoice } from './quality';
import { vttToSrt } from './subtitles';
import { rememberPending, pendingIdForDownload, pendingIdForJob } from './history';

const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

const REFUSAL_BY_COMPANION_STATE: Record<Exclude<CompanionState, 'ready'>, DownloadRefusal> = {
  notInstalled: 'companionNotInstalled',
  engineMissing: 'companionEngineMissing',
  incompatible: 'companionIncompatible',
};

export async function startDownload(request: DownloadRequest, companion: CompanionGateway): Promise<DownloadResponse> {
  const media = await findMedia(request.tabId, request.mediaKey);
  if (!media) return { ok: false, reason: 'notFound' };
  // Re-checked here, not only in the UI: the background is the single place that enforces policy.
  if (media.protection !== 'clear') return { ok: false, reason: 'protected' };
  // A live stream never ends: yt-dlp would record until cancelled and leave a broken file.
  if (media.live) return { ok: false, reason: 'live' };

  try {
    if (media.kind === 'subtitle') return await downloadSubtitle(request.tabId, media);
    const useCompanion = media.kind !== 'progressive' || request.via === 'companion';
    return useCompanion ? await downloadWithCompanion(request, media, companion) : await downloadWithBrowser(request.tabId, media);
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Lives are recorded by the companion with ffmpeg, from now until the user stops (or the live ends). */
export async function startRecording(request: RecordRequest, companion: CompanionGateway, now = new Date()): Promise<DownloadResponse> {
  const media = await findMedia(request.tabId, request.mediaKey);
  if (!media) return { ok: false, reason: 'notFound' };
  if (media.protection !== 'clear') return { ok: false, reason: 'protected' };
  if (!media.live) return { ok: false, reason: 'notLive' };

  try {
    const status = await companion.status();
    if (status.state !== 'ready') return { ok: false, reason: REFUSAL_BY_COMPANION_STATE[status.state] };

    const [settings, tab] = await Promise.all([loadSettings(), readTab(request.tabId)]);
    const jobId = newJobId(request.tabId);
    await updateTabMedia(request.tabId, list => applyJobStarted(list, media.key, jobId, true));
    await rememberPending({ id: pendingIdForJob(jobId), via: 'companion', kind: media.kind, ...pageInfo(tab) });
    await companion.send({
      type: 'record',
      jobId,
      url: media.url,
      referer: tab.url && /^https?:/.test(tab.url) ? tab.url : undefined,
      userAgent: navigator.userAgent,
      folder: settings.folder,
      fileName: recordingStem(chooseStem(media.url, tab.title ?? ''), now),
    });
    return { ok: true, via: 'companion', jobId };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export async function controlJob(action: 'stop' | 'cancel' | 'reveal', tabId: number, mediaKey: string, companion: CompanionGateway): Promise<boolean> {
  const jobId = (await findMedia(tabId, mediaKey))?.job?.id;
  if (!jobId) return false;
  await companion.send({ type: action, jobId });
  return true;
}

async function downloadWithCompanion(request: DownloadRequest, media: DetectedMedia, companion: CompanionGateway): Promise<DownloadResponse> {
  const { tabId } = request;
  const status = await companion.status();
  if (status.state !== 'ready') return { ok: false, reason: REFUSAL_BY_COMPANION_STATE[status.state] };

  const [settings, tab] = await Promise.all([loadSettings(), readTab(tabId)]);
  const jobId = newJobId(tabId);
  // Recorded before sending, so the host's first events always find their job.
  await updateTabMedia(tabId, list => applyJobStarted(list, media.key, jobId));
  await rememberPending({ id: pendingIdForJob(jobId), via: 'companion', kind: media.kind, ...pageInfo(tab) });
  await companion.send({
    type: 'download',
    jobId,
    url: media.url,
    // Many CDNs refuse requests without the page as Referer (hotlink protection).
    referer: tab.url && /^https?:/.test(tab.url) ? tab.url : undefined,
    userAgent: navigator.userAgent,
    folder: settings.folder,
    fileName: chooseStem(media.url, tab.title ?? ''),
    quality: request.quality ?? presetToChoice(settings.preset),
    subtitles: settings.subtitles,
  });
  return { ok: true, via: 'companion', jobId };
}

async function downloadWithBrowser(tabId: number, media: DetectedMedia): Promise<DownloadResponse> {
  const resumed = media.downloadId !== undefined && (await tryResume(media.downloadId));
  if (resumed) return { ok: true, via: 'browser', downloadId: media.downloadId! };

  const [settings, tab] = await Promise.all([loadSettings(), readTab(tabId)]);
  const filename = buildDownloadPath(settings.folder, chooseBaseName(media.url, media.contentType, tab.title ?? ''));
  const downloadId = await downloadWithAsciiFallback({ url: media.url, filename, saveAs: settings.askWhereToSave, conflictAction: 'uniquify' });
  await onBrowserDownloadStarted(tabId, media, tab, downloadId);
  return { ok: true, via: 'browser', downloadId };
}

async function onBrowserDownloadStarted(tabId: number, media: DetectedMedia, tab: { title?: string; url?: string }, downloadId: number) {
  await updateTabMedia(tabId, list => applyDownloadStarted(list, media.key, downloadId));
  await rememberPending({ id: pendingIdForDownload(downloadId), via: 'browser', kind: media.kind, downloadId, ...pageInfo(tab) });
}

function pageInfo(tab: { title?: string; url?: string }) {
  let pageHost = '';
  try {
    pageHost = tab.url ? new URL(tab.url).host : '';
  } catch {
    // Non-URL tab (e.g. a browser page): leave the host empty.
  }
  return { pageTitle: tab.title ?? '', pageHost };
}

async function downloadSubtitle(tabId: number, media: DetectedMedia): Promise<DownloadResponse> {
  const [settings, tab] = await Promise.all([loadSettings(), readTab(tabId)]);
  const filename = buildDownloadPath(settings.folder, `${chooseStem(media.url, tab.title ?? '')}.srt`);
  const isSrt = /\.srt$/i.test(new URL(media.url).pathname) || /subrip|srt/.test(media.contentType);

  const url = isSrt ? media.url : await convertedSrtDataUrl(media.url);
  const downloadId = await downloadWithAsciiFallback({ url, filename, saveAs: settings.askWhereToSave, conflictAction: 'uniquify' });
  await onBrowserDownloadStarted(tabId, media, tab, downloadId);
  return { ok: true, via: 'browser', downloadId };
}

/** The service worker has no Blob URLs; a data: URL carries the converted text to the downloads API. */
async function convertedSrtDataUrl(vttUrl: string): Promise<string> {
  const response = await fetch(vttUrl, { credentials: 'include', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const srt = vttToSrt(await response.text());
  if (!srt || srt.length > MAX_SUBTITLE_BYTES) throw new Error('no usable subtitle cues');
  return `data:application/x-subrip;charset=utf-8,${encodeURIComponent('\uFEFF' + srt)}`;
}

async function findMedia(tabId: number, mediaKey: string): Promise<DetectedMedia | undefined> {
  return (await readTabMedia(tabId)).find(item => item.key === mediaKey);
}

type DownloadOptions = Parameters<typeof browser.downloads.download>[0];

async function downloadWithAsciiFallback(options: DownloadOptions & { filename: string }): Promise<number> {
  try {
    return await browser.downloads.download(options);
  } catch (error) {
    const asciiName = toAsciiPath(options.filename);
    if (!isInvalidFilename(error) || asciiName === options.filename) throw error;
    return browser.downloads.download({ ...options, filename: asciiName });
  }
}

function isInvalidFilename(error: unknown): boolean {
  return error instanceof Error && /invalid filename/i.test(error.message);
}

async function tryResume(downloadId: number): Promise<boolean> {
  const [item] = await browser.downloads.search({ id: downloadId });
  if (!item?.canResume) return false;
  await browser.downloads.resume(downloadId);
  return true;
}

async function readTab(tabId: number): Promise<{ title?: string; url?: string }> {
  try {
    return await browser.tabs.get(tabId);
  } catch {
    return {};
  }
}
