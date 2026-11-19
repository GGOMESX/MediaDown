import { browser } from 'wxt/browser';
import type { MediaKind } from './media-classifier';
import { loadSettings } from './settings';

export interface HistoryEntry {
  id: string;
  fileName: string;
  pageTitle: string;
  pageHost: string;
  via: 'browser' | 'companion';
  kind: MediaKind;
  sizeBytes?: number;
  completedAt: number;
  /** Lets the history page reveal browser downloads while the browser still knows them. */
  downloadId?: number;
}

export type PendingEntry = Omit<HistoryEntry, 'fileName' | 'completedAt' | 'sizeBytes'> & { fileName?: string };

export const MAX_HISTORY = 200;
const HISTORY_KEY = 'history';
const PENDING_KEY = 'history-pending';

export const pendingIdForDownload = (downloadId: number) => `d${downloadId}`;
export const pendingIdForJob = (jobId: string) => `j${jobId}`;

export function addEntry(list: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...list.filter(item => item.id !== entry.id)].slice(0, MAX_HISTORY);
}

export async function readHistory(): Promise<HistoryEntry[]> {
  const stored = await browser.storage.local.get(HISTORY_KEY);
  return (stored[HISTORY_KEY] as HistoryEntry[] | undefined) ?? [];
}

export async function clearHistory(): Promise<void> {
  await serialized(() => browser.storage.local.remove(HISTORY_KEY));
}

/**
 * Called when a download starts: the tab may navigate (clearing its media list) long before
 * the download ends, so everything the history needs is captured now.
 */
export async function rememberPending(entry: PendingEntry): Promise<void> {
  if (!(await loadSettings()).keepHistory) return;
  await serialized(async () => {
    const pending = await readPending();
    await browser.storage.session.set({ [PENDING_KEY]: { ...pending, [entry.id]: entry } });
  });
}

export async function completePending(id: string, result: { fileName?: string; sizeBytes?: number }, now = Date.now()): Promise<void> {
  await serialized(async () => {
    const pending = await readPending();
    const entry = pending[id];
    if (!entry) return;
    delete pending[id];
    await browser.storage.session.set({ [PENDING_KEY]: pending });

    const fileName = result.fileName || entry.fileName;
    if (!fileName || !(await loadSettings()).keepHistory) return;
    const history = await readHistory();
    await browser.storage.local.set({
      [HISTORY_KEY]: addEntry(history, { ...entry, fileName, sizeBytes: result.sizeBytes, completedAt: now }),
    });
  });
}

export async function dropPending(id: string): Promise<void> {
  await serialized(async () => {
    const pending = await readPending();
    if (!(id in pending)) return;
    delete pending[id];
    await browser.storage.session.set({ [PENDING_KEY]: pending });
  });
}

async function readPending(): Promise<Record<string, PendingEntry>> {
  const stored = await browser.storage.session.get(PENDING_KEY);
  return { ...((stored[PENDING_KEY] as Record<string, PendingEntry> | undefined) ?? {}) };
}

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.catch(() => undefined).then(task);
  queue = result.catch(() => undefined);
  return result;
}
