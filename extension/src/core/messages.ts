import { parseQualityChoice, type QualityChoice } from './quality';

export type CompanionState = 'notInstalled' | 'engineMissing' | 'incompatible' | 'ready';

export interface CompanionStatus {
  state: CompanionState;
  hostVersion?: string;
  engineVersion?: string;
}

export type ExtensionRequest =
  | { type: 'download'; tabId: number; mediaKey: string; via?: 'browser' | 'companion'; quality?: QualityChoice }
  | { type: 'cancel'; tabId: number; mediaKey: string }
  | { type: 'reveal'; tabId: number; mediaKey: string }
  | { type: 'companionStatus' };

export type DownloadRequest = Extract<ExtensionRequest, { type: 'download' }>;

export type DownloadRefusal =
  | 'notFound' | 'protected' | 'live' | 'failed' | 'companionNotInstalled' | 'companionEngineMissing' | 'companionIncompatible';

export type DownloadResponse =
  | { ok: true; via: 'browser'; downloadId: number }
  | { ok: true; via: 'companion'; jobId: string }
  | { ok: false; reason: DownloadRefusal };

const MEDIA_ACTIONS = new Set(['download', 'cancel', 'reveal']);

/** Messages cross a trust boundary: validate shape instead of trusting the caller. */
export function parseRequest(raw: unknown): ExtensionRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { type, tabId, mediaKey, via, quality } = raw as Record<string, unknown>;
  if (type === 'companionStatus') return { type };
  if (typeof type !== 'string' || !MEDIA_ACTIONS.has(type)) return null;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) return null;
  if (typeof mediaKey !== 'string' || mediaKey.length === 0) return null;

  if (type === 'download') {
    if (via !== undefined && via !== 'browser' && via !== 'companion') return null;
    const choice = quality === undefined ? undefined : parseQualityChoice(quality);
    if (choice === null) return null;
    return { type, tabId, mediaKey, ...(via && { via }), ...(choice && { quality: choice }) };
  }
  return { type: type as 'cancel' | 'reveal', tabId, mediaKey };
}
