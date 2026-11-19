export type MediaKind = 'progressive' | 'hls' | 'dash';
export type Protection = 'unknown' | 'clear' | 'protected';

export interface ObservedResponse {
  url: string;
  contentType?: string;
  contentLength?: number;
}

export interface DetectedMedia {
  /** Stable identity: origin + path, so rotating query tokens do not duplicate entries. */
  key: string;
  url: string;
  kind: MediaKind;
  contentType: string;
  protection: Protection;
  sizeBytes?: number;
  /** Keys of variant playlists, set only on an inspected HLS master playlist. */
  variantKeys?: string[];
  /** Id from chrome.downloads, once the user started a download of this media. */
  downloadId?: number;
  detectedAt: number;
}

const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];
const DASH_TYPES = ['application/dash+xml'];
const PROGRESSIVE_TYPE = /^video\/(mp4|webm|quicktime|x-matroska|ogg)$/;
const PROGRESSIVE_EXTENSION = /\.(mp4|webm|mov|mkv|ogv)$/i;

// Fragments of HLS/DASH streams: listing each one would bury the real video under hundreds of rows.
const SEGMENT_EXTENSION = /\.(m4s|ts|cmfv|cmfa|aac)$/i;
const SEGMENT_NAME = /(segment|chunk|frag(ment)?)[-_]?\d+/i;

export function classifyRequest(response: ObservedResponse, now: number = Date.now()): DetectedMedia | null {
  const url = parseHttpUrl(response.url);
  if (!url) return null;

  const contentType = normalizeContentType(response.contentType);
  const kind = detectKind(url.pathname, contentType);
  if (!kind) return null;

  return {
    key: mediaKey(url.href),
    url: url.href,
    kind,
    contentType,
    protection: kind === 'progressive' ? 'clear' : 'unknown',
    sizeBytes: response.contentLength && response.contentLength > 0 ? response.contentLength : undefined,
    detectedAt: now,
  };
}

export function mediaKey(rawUrl: string): string {
  const url = new URL(rawUrl);
  return url.origin + url.pathname;
}

function detectKind(pathname: string, contentType: string): MediaKind | null {
  if (pathname.toLowerCase().endsWith('.m3u8') || HLS_TYPES.includes(contentType)) return 'hls';
  if (pathname.toLowerCase().endsWith('.mpd') || DASH_TYPES.includes(contentType)) return 'dash';
  if (isSegment(pathname)) return null;
  if (PROGRESSIVE_TYPE.test(contentType) || PROGRESSIVE_EXTENSION.test(pathname)) return 'progressive';
  return null;
}

function isSegment(pathname: string): boolean {
  const fileName = pathname.slice(pathname.lastIndexOf('/') + 1);
  return SEGMENT_EXTENSION.test(fileName) || SEGMENT_NAME.test(fileName);
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function normalizeContentType(raw: string | undefined): string {
  return (raw ?? '').split(';')[0]!.trim().toLowerCase();
}
