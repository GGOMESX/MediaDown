const FORBIDDEN_CHARS = /[/\\:*?"<>|]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const EDGE_DOTS_AND_SPACES = /^[\s.]+|[\s.]+$/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
const MAX_FILE_NAME_LENGTH = 150;
const FALLBACK_NAME = 'video';

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'mkv', 'ogv', 'm4v'] as const;
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogv',
};
// CDN names like "3f9a8c2e1b7d4a6f" or "123456789" tell the user nothing; the page title is better.
const MACHINE_GENERATED_STEM = /^([a-f0-9-]{16,}|\d{6,})$/i;

export function sanitizeFileName(raw: string): string {
  const cleaned = cleanSegment(raw);
  if (!cleaned) return FALLBACK_NAME;
  const safe = WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
  return truncatePreservingExtension(safe, MAX_FILE_NAME_LENGTH);
}

export function sanitizeFolder(raw: string): string {
  return raw
    .split(/[/\\]+/)
    .filter(segment => segment !== '.' && segment !== '..')
    .map(cleanSegment)
    .filter(Boolean)
    .map(segment => (WINDOWS_RESERVED.test(segment) ? `_${segment}` : segment))
    .join('/');
}

export function chooseBaseName(rawUrl: string, contentType: string, pageTitle: string): string {
  const { stem, extension } = splitUrlFileName(rawUrl);
  const title = pageTitle.trim();
  const name = MACHINE_GENERATED_STEM.test(stem) && title ? title : stem;
  const finalExtension = extension ?? EXTENSION_BY_CONTENT_TYPE[contentType] ?? 'mp4';
  return sanitizeFileName(`${name}.${finalExtension}`);
}

const GENERIC_STREAM_STEM = /^(index|master|playlist|manifest|chunklist|stream|video|media)([-_]?\w{0,8})?$/i;

/**
 * Name (without extension) for a companion download; yt-dlp appends the real extension.
 * Stream manifests are almost always called "index"/"master", so the page title wins for them.
 */
export function chooseStem(rawUrl: string, pageTitle: string): string {
  const { stem } = splitUrlFileName(rawUrl);
  const withoutManifestExtension = stem.replace(/\.(m3u8|mpd)$/i, '');
  const title = pageTitle.trim();
  const uninformative = GENERIC_STREAM_STEM.test(withoutManifestExtension) || MACHINE_GENERATED_STEM.test(withoutManifestExtension);
  const name = uninformative && title ? title : withoutManifestExtension;
  return sanitizeFileName(name).replace(/\.(mp4|webm|mov|mkv|ogv|m4v)$/i, '');
}

/** chrome.downloads expects a path relative to the Downloads folder, always with "/". */
export function buildDownloadPath(folder: string, fileName: string): string {
  return folder ? `${folder}/${fileName}` : fileName;
}

/**
 * Last-resort path for systems whose filesystem encoding cannot hold the original name
 * (e.g. Linux under the "C" locale): strip accents, replace anything else non-ASCII.
 */
export function toAsciiPath(path: string): string {
  return path
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_');
}

function cleanSegment(raw: string): string {
  return raw.replace(CONTROL_CHARS, '').replace(FORBIDDEN_CHARS, '_').replace(EDGE_DOTS_AND_SPACES, '');
}

function splitUrlFileName(rawUrl: string): { stem: string; extension?: string } {
  const url = new URL(rawUrl);
  const lastSegment = safeDecode(url.pathname.split('/').filter(Boolean).at(-1) ?? url.hostname);
  const dot = lastSegment.lastIndexOf('.');
  const candidate = dot > 0 ? lastSegment.slice(dot + 1).toLowerCase() : '';

  return (VIDEO_EXTENSIONS as readonly string[]).includes(candidate)
    ? { stem: lastSegment.slice(0, dot), extension: candidate }
    : { stem: lastSegment };
}

function truncatePreservingExtension(name: string, maxLength: number): string {
  const characters = Array.from(name);
  if (characters.length <= maxLength) return name;
  const extension = name.match(/\.[a-z0-9]{1,5}$/i)?.[0] ?? '';
  return characters.slice(0, maxLength - extension.length).join('') + extension;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
