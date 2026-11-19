export interface DownloadRequest {
  type: 'download';
  tabId: number;
  mediaKey: string;
}

export type DownloadRefusal = 'notFound' | 'protected' | 'needsCompanion' | 'failed';

export type DownloadResponse =
  | { ok: true; downloadId: number }
  | { ok: false; reason: DownloadRefusal };

/** Messages cross a trust boundary: validate shape instead of trusting the caller. */
export function parseRequest(raw: unknown): DownloadRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { type, tabId, mediaKey } = raw as Record<string, unknown>;
  if (type !== 'download') return null;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) return null;
  if (typeof mediaKey !== 'string' || mediaKey.length === 0) return null;
  return { type, tabId, mediaKey };
}
