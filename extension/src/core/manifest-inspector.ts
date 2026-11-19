import type { StreamKind, Protection } from './media-classifier';

export interface ManifestInspection {
  protection: Exclude<Protection, 'unknown'>;
  /** Child playlists to hide behind the master: video variants first, then audio/subtitle renditions. */
  variantUrls: string[];
  /** Distinct video heights offered (e.g. [1080, 720, 360]), highest first. */
  heights: number[];
  /** null for an HLS master playlist: only its variant playlists say whether the stream is live. */
  live: boolean | null;
  subtitleLanguages: string[];
}

// Deliberately conservative: any encryption, including AES-128, counts as a technical
// protection measure. Circumventing one is where the legal line is, so we never cross it.
const HLS_ENCRYPTION = /^#EXT-X-(SESSION-)?KEY:(?!.*METHOD=NONE)/im;
const DASH_ENCRYPTION = /<(\w+:)?ContentProtection\b/i;
const HLS_ENDED = /^#EXT-X-(ENDLIST|PLAYLIST-TYPE:VOD)\b/im;

export function inspectManifest(kind: StreamKind, body: string, manifestUrl: string): ManifestInspection {
  return kind === 'dash' ? inspectDash(body) : inspectHls(body, manifestUrl);
}

/**
 * A master playlist rarely declares keys or the end of the stream; its variant playlists do.
 * The stream is protected if either level says so.
 */
export function combineWithVariant(master: ManifestInspection, variant: ManifestInspection | null): ManifestInspection | null {
  if (master.live !== null) return master;
  if (!variant) return null;
  return {
    ...master,
    protection: master.protection === 'protected' || variant.protection === 'protected' ? 'protected' : 'clear',
    live: variant.live ?? false,
  };
}

function inspectHls(body: string, manifestUrl: string): ManifestInspection {
  const lines = body.split(/\r?\n/).map(line => line.trim());
  const variantUrls: string[] = [];
  const heights: number[] = [];
  const subtitleLanguages: string[] = [];
  const renditionUrls: string[] = [];

  lines.forEach((line, index) => {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const uri = lines.slice(index + 1).find(next => next !== '' && !next.startsWith('#'));
      const resolved = uri && resolveUrl(uri, manifestUrl);
      if (resolved) variantUrls.push(resolved);
      const height = Number(attribute(line, 'RESOLUTION')?.split('x')[1]);
      if (height > 0) heights.push(height);
    } else if (line.startsWith('#EXT-X-MEDIA')) {
      const uri = attribute(line, 'URI');
      const resolved = uri && resolveUrl(uri, manifestUrl);
      if (resolved) renditionUrls.push(resolved);
      if (attribute(line, 'TYPE') === 'SUBTITLES') subtitleLanguages.push(attribute(line, 'LANGUAGE') ?? attribute(line, 'NAME') ?? '?');
    }
  });

  const isMaster = variantUrls.length > 0;
  return {
    protection: HLS_ENCRYPTION.test(body) ? 'protected' : 'clear',
    variantUrls: isMaster ? [...variantUrls, ...renditionUrls] : [],
    heights: distinctDescending(heights),
    live: isMaster ? null : !HLS_ENDED.test(body),
    subtitleLanguages: distinct(subtitleLanguages),
  };
}

function inspectDash(body: string): ManifestInspection {
  const heights = [...body.matchAll(/<(?:\w+:)?Representation\b[^>]*\sheight="(\d+)"/gi)].map(match => Number(match[1]));
  const textSets = [...body.matchAll(/<(?:\w+:)?AdaptationSet\b[^>]*>/gi)]
    .map(match => match[0])
    .filter(tag => /contentType="text"|mimeType="(text\/vtt|application\/ttml\+xml)"/i.test(tag));
  return {
    protection: DASH_ENCRYPTION.test(body) ? 'protected' : 'clear',
    variantUrls: [],
    heights: distinctDescending(heights),
    live: /<(?:\w+:)?MPD\b[^>]*\stype="dynamic"/i.test(body),
    subtitleLanguages: distinct(textSets.map(tag => tag.match(/\slang="([^"]+)"/i)?.[1] ?? '?')),
  };
}

/** Reads `NAME=value` or `NAME="value"` from an HLS attribute list. */
function attribute(line: string, name: string): string | undefined {
  const match = line.match(new RegExp(`[:,]${name}=("([^"]*)"|[^,]*)`));
  return match ? (match[2] ?? match[1]) : undefined;
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function distinctDescending(values: number[]): number[] {
  return distinct(values).sort((a, b) => b - a);
}

function resolveUrl(reference: string, base: string): string | null {
  try {
    return new URL(reference, base).href;
  } catch {
    return null;
  }
}
