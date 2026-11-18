import { describe, it, expect } from 'vitest';
import { classifyRequest, mediaKey } from './media-classifier';

const NOW = 1_700_000_000_000;

describe('classifyRequest', () => {
  it('identifies HLS by extension', () => {
    const media = classifyRequest({ url: 'https://cdn.example.com/live/index.m3u8?token=abc' }, NOW);
    expect(media?.kind).toBe('hls');
  });

  it('identifies HLS by content-type even without extension', () => {
    const media = classifyRequest({ url: 'https://cdn.example.com/play?id=1', contentType: 'application/vnd.apple.mpegurl' }, NOW);
    expect(media?.kind).toBe('hls');
  });

  it('identifies DASH by extension or content-type', () => {
    expect(classifyRequest({ url: 'https://cdn.example.com/v/manifest.mpd' }, NOW)?.kind).toBe('dash');
    expect(classifyRequest({ url: 'https://cdn.example.com/v', contentType: 'application/dash+xml' }, NOW)?.kind).toBe('dash');
  });

  it('identifies progressive video by content-type, ignoring parameters and case', () => {
    const media = classifyRequest({ url: 'https://cdn.example.com/v?id=9', contentType: 'Video/MP4; codecs="avc1"' }, NOW);
    expect(media?.kind).toBe('progressive');
    expect(media?.contentType).toBe('video/mp4');
  });

  it('identifies progressive video by extension when content-type is generic', () => {
    const media = classifyRequest({ url: 'https://cdn.example.com/clip.webm', contentType: 'application/octet-stream' }, NOW);
    expect(media?.kind).toBe('progressive');
  });

  it('records size from content-length', () => {
    const media = classifyRequest({ url: 'https://cdn.example.com/a.mp4', contentType: 'video/mp4', contentLength: 5_000_000 }, NOW);
    expect(media?.sizeBytes).toBe(5_000_000);
  });

  it('ignores streaming segments, which are fragments and not whole videos', () => {
    expect(classifyRequest({ url: 'https://cdn.example.com/v/chunk-00042.m4s', contentType: 'video/mp4' }, NOW)).toBeNull();
    expect(classifyRequest({ url: 'https://cdn.example.com/v/seg_12.ts', contentType: 'video/mp2t' }, NOW)).toBeNull();
    expect(classifyRequest({ url: 'https://cdn.example.com/v/segment-3.mp4', contentType: 'video/mp4' }, NOW)).toBeNull();
  });

  it('ignores non-media responses', () => {
    expect(classifyRequest({ url: 'https://example.com/app.js', contentType: 'text/javascript' }, NOW)).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(classifyRequest({ url: 'file:///etc/passwd', contentType: 'video/mp4' }, NOW)).toBeNull();
    expect(classifyRequest({ url: 'blob:https://example.com/123', contentType: 'video/mp4' }, NOW)).toBeNull();
    expect(classifyRequest({ url: 'not a url', contentType: 'video/mp4' }, NOW)).toBeNull();
  });

  it('starts with unknown protection for manifests and clear for progressive files', () => {
    expect(classifyRequest({ url: 'https://c.example.com/a.m3u8' }, NOW)?.protection).toBe('unknown');
    expect(classifyRequest({ url: 'https://c.example.com/a.mp4', contentType: 'video/mp4' }, NOW)?.protection).toBe('clear');
  });
});

describe('mediaKey', () => {
  it('ignores the query string so rotating CDN tokens do not create duplicates', () => {
    expect(mediaKey('https://cdn.example.com/a.mp4?t=1')).toBe(mediaKey('https://cdn.example.com/a.mp4?t=2'));
  });

  it('distinguishes different paths', () => {
    expect(mediaKey('https://cdn.example.com/a.mp4')).not.toBe(mediaKey('https://cdn.example.com/b.mp4'));
  });
});
