import type { MediaKind, Protection } from './media-classifier';

export interface ManifestInspection {
  protection: Exclude<Protection, 'unknown'>;
  variantUrls: string[];
}

// Deliberately conservative: any encryption, including AES-128, counts as a technical
// protection measure. Circumventing one is where the legal line is, so we never cross it.
const HLS_ENCRYPTION = /^#EXT-X-(SESSION-)?KEY:(?!.*METHOD=NONE)/im;
const DASH_ENCRYPTION = /<(\w+:)?ContentProtection\b/i;

export function inspectManifest(kind: Exclude<MediaKind, 'progressive'>, body: string, manifestUrl: string): ManifestInspection {
  if (kind === 'dash') {
    return { protection: DASH_ENCRYPTION.test(body) ? 'protected' : 'clear', variantUrls: [] };
  }
  return {
    protection: HLS_ENCRYPTION.test(body) ? 'protected' : 'clear',
    variantUrls: extractHlsVariantUrls(body, manifestUrl),
  };
}

function extractHlsVariantUrls(body: string, manifestUrl: string): string[] {
  const lines = body.split(/\r?\n/).map(line => line.trim());
  const variants: string[] = [];

  lines.forEach((line, index) => {
    if (!line.startsWith('#EXT-X-STREAM-INF')) return;
    const uri = lines.slice(index + 1).find(next => next !== '' && !next.startsWith('#'));
    const resolved = uri && resolveUrl(uri, manifestUrl);
    if (resolved) variants.push(resolved);
  });

  return variants;
}

function resolveUrl(reference: string, base: string): string | null {
  try {
    return new URL(reference, base).href;
  } catch {
    return null;
  }
}
