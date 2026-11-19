import type { CompanionJob } from './companion-job';

export type MediaKind = 'progressive' | 'hls' | 'dash' | 'subtitle';
export type StreamKind = 'hls' | 'dash';
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
  /** Video heights offered by an HLS/DASH stream, highest first. */
  heights?: number[];
  /** A live stream has no end; recording it is not supported yet. */
  live?: boolean;
  subtitleLanguages?: string[];
  /** Id from chrome.downloads, once the user started a download of this media. */
  downloadId?: number;
  /** Download handled by the companion app (HLS/DASH, or files the browser could not fetch). */
  job?: CompanionJob;
  detectedAt: number;
}

const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];
const DASH_TYPES = ['application/dash+xml'];
const PROGRESSIVE_TYPE = /^video\/(mp4|webm|quicktime|x-matroska|ogg)$/;
const PROGRESSIVE_EXTENSION = /\.(mp4|webm|mov|mkv|ogv)$/i;

const SUBTITLE_TYPES = ['text/vtt', 'application/x-subrip', 'text/srt', 'application/srt'];
const SUBTITLE_EXTENSION = /\.(vtt|webvtt|srt)$/i;
// Subtitle tracks of HLS streams arrive as numbered .vtt segments; only whole files are useful.
const SUBTITLE_SEGMENT_NAME = /(^\d+|(segment|chunk|frag(ment)?|seq(uence)?|part)[-_]?\d+|[-_]\d{3,})\.(vtt|webvtt)$/i;

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
    protection: kind === 'hls' || kind === 'dash' ? 'unknown' : 'clear',
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
  if (SUBTITLE_TYPES.includes(contentType) || SUBTITLE_EXTENSION.test(pathname)) {
    return SUBTITLE_SEGMENT_NAME.test(pathname.slice(pathname.lastIndexOf('/') + 1)) ? null : 'subtitle';
  }
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
