const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const GENERIC_NAMES = /^(index|master|playlist|manifest|video|stream)\.(m3u8|mpd)$/i;

export function formatBytes(bytes: number | undefined, locale?: string): string {
  if (bytes === undefined) return '';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  if (exponent === 0) return `${bytes} B`;
  const value = (bytes / 1024 ** exponent).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${value} ${UNITS[exponent]}`;
}

export function displayName(rawUrl: string): string {
  const url = new URL(rawUrl);
  const segments = url.pathname.split('/').filter(Boolean).map(safeDecode);
  const fileName = segments.at(-1);
  if (!fileName) return url.host;

  const parent = segments.at(-2);
  return GENERIC_NAMES.test(fileName) && parent ? `${parent}/${fileName}` : fileName;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
