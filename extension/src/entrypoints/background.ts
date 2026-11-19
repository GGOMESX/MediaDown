import { browser } from 'wxt/browser';
import { classifyRequest, type DetectedMedia } from '@/core/media-classifier';
import { toObservedResponse } from '@/core/response-headers';
import { mergeMedia, applyInspection, visibleMedia } from '@/core/tab-media';
import { updateTabMedia, clearTabMedia } from '@/core/tab-media-store';
import { fetchAndInspectManifest } from '@/core/manifest-fetcher';
import { parseRequest, type DownloadResponse } from '@/core/messages';
import { startDownload } from '@/core/download-service';

const OBSERVED_TYPES = ['media', 'xmlhttprequest', 'other', 'object'] as const;
const inspectionsInFlight = new Set<string>();

export default defineBackground(() => {
  browser.webRequest.onHeadersReceived.addListener(
    details => void handleResponse(details.tabId, details.url, details.statusCode, details.responseHeaders),
    { urls: ['<all_urls>'], types: [...OBSERVED_TYPES] },
    ['responseHeaders'],
  );

  // A new top-level document means a new page: forget the previous page's media.
  browser.webRequest.onBeforeRequest.addListener(
    details => void resetTab(details.tabId),
    { urls: ['<all_urls>'], types: ['main_frame'] },
  );

  browser.tabs.onRemoved.addListener(tabId => void clearTabMedia(tabId));

  browser.runtime.onMessage.addListener((message, sender): Promise<DownloadResponse> | undefined => {
    // Only our own extension pages (popup) may ask for downloads, never content in a web page.
    if (sender.id !== browser.runtime.id || sender.tab?.url?.startsWith('http')) return undefined;
    const request = parseRequest(message);
    return request ? startDownload(request) : undefined;
  });
});

async function handleResponse(tabId: number, url: string, statusCode: number, headers?: { name: string; value?: string }[]) {
  if (tabId < 0 || (statusCode !== 200 && statusCode !== 206)) return;

  const media = classifyRequest(toObservedResponse(url, headers));
  if (!media) return;

  const list = await updateTabMedia(tabId, current => mergeMedia(current, media));
  await refreshBadge(tabId, list);

  const stored = list.find(item => item.key === media.key);
  if (stored?.protection === 'unknown') await inspect(tabId, stored);
}

async function inspect(tabId: number, media: DetectedMedia) {
  if (media.kind === 'progressive' || inspectionsInFlight.has(media.key)) return;
  inspectionsInFlight.add(media.key);
  try {
    const inspection = await fetchAndInspectManifest(media.url, media.kind);
    if (!inspection) return;
    const list = await updateTabMedia(tabId, current => applyInspection(current, media.key, inspection));
    await refreshBadge(tabId, list);
  } finally {
    inspectionsInFlight.delete(media.key);
  }
}

async function resetTab(tabId: number) {
  if (tabId < 0) return;
  await clearTabMedia(tabId);
  await refreshBadge(tabId, []);
}

async function refreshBadge(tabId: number, list: DetectedMedia[]) {
  const action = browser.action ?? browser.browserAction;
  const count = visibleMedia(list).length;
  try {
    await action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
    await action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
  } catch {
    // The tab may have closed between the request and the badge update.
  }
}
