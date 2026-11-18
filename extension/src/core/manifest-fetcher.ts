import { inspectManifest, type ManifestInspection } from './manifest-inspector';
import type { MediaKind } from './media-classifier';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

/** Returns null when the manifest cannot be read; the media then stays "unknown" instead of guessing. */
export async function fetchAndInspectManifest(url: string, kind: Exclude<MediaKind, 'progressive'>): Promise<ManifestInspection | null> {
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
