import { mediaKey, type DetectedMedia } from './media-classifier';
import type { ManifestInspection } from './manifest-inspector';

export type { DetectedMedia } from './media-classifier';

export const MAX_MEDIA_PER_TAB = 50;

export function mergeMedia(list: readonly DetectedMedia[], incoming: DetectedMedia): DetectedMedia[] {
  const existing = list.find(item => item.key === incoming.key);
  const parent = findParentMaster(list, incoming.key);

  const merged: DetectedMedia = {
    ...existing,
    ...incoming,
    sizeBytes: incoming.sizeBytes ?? existing?.sizeBytes,
    protection: pickProtection(incoming, existing, parent),
    variantKeys: existing?.variantKeys,
  };

  const next = existing
    ? list.map(item => (item.key === incoming.key ? merged : item))
    : [...list, merged];

  return next.slice(-MAX_MEDIA_PER_TAB);
}

export function applyInspection(list: readonly DetectedMedia[], key: string, inspection: ManifestInspection): DetectedMedia[] {
  if (!list.some(item => item.key === key)) return [...list];

  const variantKeys = inspection.variantUrls.map(mediaKey);
  return list.map(item => {
    if (item.key === key) return { ...item, protection: inspection.protection, variantKeys };
    if (variantKeys.includes(item.key)) return { ...item, protection: inspection.protection };
    return item;
  });
}

export function applyDownloadStarted(list: readonly DetectedMedia[], key: string, downloadId: number): DetectedMedia[] {
  return list.map(item => (item.key === key ? { ...item, downloadId } : item));
}

/** Media worth showing: variant playlists are hidden behind their master playlist. */
export function visibleMedia(list: readonly DetectedMedia[]): DetectedMedia[] {
  const hidden = new Set(list.flatMap(item => item.variantKeys ?? []));
  return list.filter(item => !hidden.has(item.key));
}

function findParentMaster(list: readonly DetectedMedia[], key: string): DetectedMedia | undefined {
  return list.find(item => item.variantKeys?.includes(key));
}

function pickProtection(incoming: DetectedMedia, existing?: DetectedMedia, parent?: DetectedMedia) {
  if (parent && parent.protection !== 'unknown') return parent.protection;
  if (incoming.protection === 'unknown' && existing) return existing.protection;
  return incoming.protection;
}
