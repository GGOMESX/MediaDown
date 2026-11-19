import { browser } from 'wxt/browser';
import type { DownloadRequest, DownloadResponse } from './messages';
import { readTabMedia, updateTabMedia } from './tab-media-store';
import { applyDownloadStarted } from './tab-media';
import { loadSettings } from './settings';
import { buildDownloadPath, chooseBaseName, toAsciiPath } from './file-name';

export async function startDownload({ tabId, mediaKey }: DownloadRequest): Promise<DownloadResponse> {
  const media = (await readTabMedia(tabId)).find(item => item.key === mediaKey);
  if (!media) return { ok: false, reason: 'notFound' };
  // Re-checked here, not only in the UI: the background is the single place that enforces policy.
  if (media.protection !== 'clear') return { ok: false, reason: 'protected' };
  if (media.kind !== 'progressive') return { ok: false, reason: 'needsCompanion' };

  try {
    const resumed = media.downloadId !== undefined && (await tryResume(media.downloadId));
    if (resumed) return { ok: true, downloadId: media.downloadId! };

    const [settings, pageTitle] = await Promise.all([loadSettings(), readTabTitle(tabId)]);
    const filename = buildDownloadPath(settings.folder, chooseBaseName(media.url, media.contentType, pageTitle));
    const downloadId = await downloadWithAsciiFallback({
      url: media.url,
      filename,
      saveAs: settings.askWhereToSave,
      conflictAction: 'uniquify',
    });
    await updateTabMedia(tabId, list => applyDownloadStarted(list, mediaKey, downloadId));
    return { ok: true, downloadId };
  } catch {
    return { ok: false, reason: 'failed' };
  }
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

async function readTabTitle(tabId: number): Promise<string> {
  try {
    return (await browser.tabs.get(tabId)).title ?? '';
  } catch {
    return '';
  }
}
