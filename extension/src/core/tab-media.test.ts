import { describe, it, expect } from 'vitest';
import { mergeMedia, applyInspection, applyDownloadStarted, visibleMedia, type DetectedMedia } from './tab-media';
import type { ManifestInspection } from './manifest-inspector';

function inspection(overrides: Partial<ManifestInspection>): ManifestInspection {
  return { protection: 'clear', variantUrls: [], heights: [], variantHeights: [], live: false, subtitleLanguages: [], ...overrides };
}

function media(url: string, overrides: Partial<DetectedMedia> = {}): DetectedMedia {
  return {
    key: new URL(url).origin + new URL(url).pathname,
    url,
    kind: url.includes('.m3u8') ? 'hls' : 'progressive',
    contentType: '',
    protection: url.includes('.m3u8') ? 'unknown' : 'clear',
    detectedAt: 1,
    ...overrides,
  };
}

describe('mergeMedia', () => {
  it('appends new media', () => {
    const list = mergeMedia([], media('https://c.example.com/a.mp4'));
    expect(list).toHaveLength(1);
  });

  it('replaces the URL of an existing entry with the freshest one (signed URLs expire)', () => {
    const first = mergeMedia([], media('https://c.example.com/a.mp4?t=old'));
    const second = mergeMedia(first, media('https://c.example.com/a.mp4?t=new', { detectedAt: 2 }));
    expect(second).toHaveLength(1);
    expect(second[0]?.url).toBe('https://c.example.com/a.mp4?t=new');
  });

  it('keeps known size and protection when a later request lacks them', () => {
    const first = mergeMedia([], media('https://c.example.com/a.m3u8', { protection: 'clear', sizeBytes: 10 }));
    const second = mergeMedia(first, media('https://c.example.com/a.m3u8'));
    expect(second[0]?.protection).toBe('clear');
    expect(second[0]?.sizeBytes).toBe(10);
  });

  it('caps the list so a page streaming for hours cannot grow storage without bound', () => {
    let list: DetectedMedia[] = [];
    for (let i = 0; i < 80; i++) list = mergeMedia(list, media(`https://c.example.com/${i}.mp4`));
    expect(list).toHaveLength(50);
    expect(list[0]?.url).toBe('https://c.example.com/30.mp4');
  });
});

describe('applyInspection', () => {
  it('sets protection on the inspected manifest', () => {
    const list = [media('https://c.example.com/master.m3u8')];
    const result = applyInspection(list, list[0]!.key, inspection({ protection: 'protected', variantUrls: [] }));
    expect(result[0]?.protection).toBe('protected');
  });

  it('hides variants of a master playlist, including ones detected later', () => {
    const master = media('https://c.example.com/master.m3u8');
    const variant = media('https://c.example.com/720p/index.m3u8?sig=1');
    let list = applyInspection([master, variant], master.key, inspection({ protection: 'clear', variantUrls: ['https://c.example.com/720p/index.m3u8?sig=1', 'https://c.example.com/360p/index.m3u8'] }));
    list = mergeMedia(list, media('https://c.example.com/360p/index.m3u8?sig=2'));

    expect(visibleMedia(list).map(m => m.url)).toEqual(['https://c.example.com/master.m3u8']);
  });

  it('propagates the master protection status to its variants', () => {
    const master = media('https://c.example.com/master.m3u8');
    const variant = media('https://c.example.com/720p/index.m3u8');
    const list = applyInspection([master, variant], master.key, inspection({ protection: 'protected', variantUrls: ['https://c.example.com/720p/index.m3u8'] }));
    expect(list.find(m => m.key === variant.key)?.protection).toBe('protected');
  });

  it('ignores inspections for media that is no longer listed', () => {
    const list = [media('https://c.example.com/a.mp4')];
    expect(applyInspection(list, 'https://gone.example.com/x.m3u8', inspection({ protection: 'clear', variantUrls: [] }))).toEqual(list);
  });
});

describe('applyInspection details', () => {
  it('stores heights, liveness and subtitle languages on the inspected stream', () => {
    const list = [media('https://c.example.com/master.m3u8')];
    const [result] = applyInspection(list, list[0]!.key, inspection({ heights: [1080, 720], live: true, subtitleLanguages: ['pt-BR'] }));
    expect(result).toMatchObject({ heights: [1080, 720], live: true, subtitleLanguages: ['pt-BR'] });
  });
});

describe('applyDownloadStarted', () => {
  it('links a download to its media', () => {
    const list = [media('https://c.example.com/a.mp4'), media('https://c.example.com/b.mp4')];
    const result = applyDownloadStarted(list, list[0]!.key, 42);
    expect(result.map(m => m.downloadId)).toEqual([42, undefined]);
  });

  it('keeps the download link when the same media is seen again', () => {
    const list = applyDownloadStarted([media('https://c.example.com/a.mp4')], 'https://c.example.com/a.mp4', 7);
    const merged = mergeMedia(list, media('https://c.example.com/a.mp4?t=new'));
    expect(merged[0]?.downloadId).toBe(7);
  });
});
