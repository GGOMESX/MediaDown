import { browser } from 'wxt/browser';
import type { DownloadRequest, DownloadResponse, DownloadRefusal, CompanionState } from './messages';
import type { DetectedMedia } from './media-classifier';
import type { CompanionGateway } from './companion-client';
import { readTabMedia, updateTabMedia } from './tab-media-store';
import { applyDownloadStarted } from './tab-media';
import { applyJobStarted, newJobId } from './companion-job';
import { loadSettings } from './settings';
import { buildDownloadPath, chooseBaseName, chooseStem, toAsciiPath } from './file-name';

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

  const useCompanion = media.kind !== 'progressive' || request.via === 'companion';
  try {
    return useCompanion ? await downloadWithCompanion(request.tabId, media, companion) : await downloadWithBrowser(request.tabId, media);
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export async function controlJob(action: 'cancel' | 'reveal', tabId: number, mediaKey: string, companion: CompanionGateway): Promise<boolean> {
  const jobId = (await findMedia(tabId, mediaKey))?.job?.id;
  if (!jobId) return false;
  await companion.send({ type: action, jobId });
  return true;
}

async function downloadWithCompanion(tabId: number, media: DetectedMedia, companion: CompanionGateway): Promise<DownloadResponse> {
  const status = await companion.status();
  if (status.state !== 'ready') return { ok: false, reason: REFUSAL_BY_COMPANION_STATE[status.state] };

  const [settings, tab] = await Promise.all([loadSettings(), readTab(tabId)]);
  const jobId = newJobId(tabId);
  // Recorded before sending, so the host's first events always find their job.
  await updateTabMedia(tabId, list => applyJobStarted(list, media.key, jobId));
  await companion.send({
    type: 'download',
    jobId,
    url: media.url,
    // Many CDNs refuse requests without the page as Referer (hotlink protection).
    referer: tab.url && /^https?:/.test(tab.url) ? tab.url : undefined,
    userAgent: navigator.userAgent,
    folder: settings.folder,
    fileName: chooseStem(media.url, tab.title ?? ''),
    preset: settings.preset,
  });
  return { ok: true, via: 'companion', jobId };
}

async function downloadWithBrowser(tabId: number, media: DetectedMedia): Promise<DownloadResponse> {
  const resumed = media.downloadId !== undefined && (await tryResume(media.downloadId));
  if (resumed) return { ok: true, via: 'browser', downloadId: media.downloadId! };

  const [settings, tab] = await Promise.all([loadSettings(), readTab(tabId)]);
  const filename = buildDownloadPath(settings.folder, chooseBaseName(media.url, media.contentType, tab.title ?? ''));
  const downloadId = await downloadWithAsciiFallback({ url: media.url, filename, saveAs: settings.askWhereToSave, conflictAction: 'uniquify' });
  await updateTabMedia(tabId, list => applyDownloadStarted(list, media.key, downloadId));
  return { ok: true, via: 'browser', downloadId };
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
