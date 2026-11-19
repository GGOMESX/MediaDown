import { browser } from 'wxt/browser';
import type { DetectedMedia } from './media-classifier';

// storage.session survives the MV3 service worker being suspended (~30s idle),
// but not a browser restart, which matches the lifetime of a tab.
const storageKey = (tabId: number) => `tab-media:${tabId}`;
const pendingByTab = new Map<number, Promise<unknown>>();

export function tabIdFromStorageKey(key: string): number | null {
  const match = key.match(/^tab-media:(\d+)$/);
  return match ? Number(match[1]) : null;
}

export async function readTabMedia(tabId: number): Promise<DetectedMedia[]> {
  const key = storageKey(tabId);
  const stored = await browser.storage.session.get(key);
  return (stored[key] as DetectedMedia[] | undefined) ?? [];
}

export async function readAllTabIds(): Promise<number[]> {
  const stored = await browser.storage.session.get(null);
  return Object.keys(stored).map(tabIdFromStorageKey).filter((id): id is number => id !== null);
}

/** Read-modify-write serialized per tab, so concurrent webRequest events cannot overwrite each other. */
export function updateTabMedia(tabId: number, update: (list: DetectedMedia[]) => DetectedMedia[]): Promise<DetectedMedia[]> {
  return enqueue(tabId, async () => {
    const next = update(await readTabMedia(tabId));
    await browser.storage.session.set({ [storageKey(tabId)]: next });
    return next;
  });
}

export function clearTabMedia(tabId: number): Promise<void> {
  return enqueue(tabId, () => browser.storage.session.remove(storageKey(tabId)));
}

function enqueue<T>(tabId: number, task: () => Promise<T>): Promise<T> {
  const previous = pendingByTab.get(tabId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(task);
  const settled = result.catch(() => undefined);
  pendingByTab.set(tabId, settled);
  void settled.then(() => {
    if (pendingByTab.get(tabId) === settled) pendingByTab.delete(tabId);
  });
  return result;
}
