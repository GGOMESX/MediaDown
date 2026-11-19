import { inspectManifest, combineWithVariant, type ManifestInspection } from './manifest-inspector';
import type { StreamKind } from './media-classifier';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

/** Returns null when the manifest cannot be read; the media then stays "unknown" instead of guessing. */
export async function fetchAndInspectManifest(url: string, kind: StreamKind): Promise<ManifestInspection | null> {
  const master = await fetchInspection(url, kind);
  if (!master || master.live !== null || !master.variantUrls[0]) return master;
  // Keys and the end-of-stream marker live in the variant playlists, not the master.
  return combineWithVariant(master, await fetchInspection(master.variantUrls[0], kind));
}

async function fetchInspection(url: string, kind: StreamKind): Promise<ManifestInspection | null> {
  try {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;

    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_MANIFEST_BYTES) return null;

    const body = await response.text();
    if (body.length > MAX_MANIFEST_BYTES) return null;

    return inspectManifest(kind, body, response.url || url);
  } catch {
    return null;
  }
}
