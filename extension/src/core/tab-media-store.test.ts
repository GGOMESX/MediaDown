import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { readTabMedia, updateTabMedia, clearTabMedia } from './tab-media-store';
import { mergeMedia } from './tab-media';
import { classifyRequest } from './media-classifier';

const mediaAt = (path: string) => classifyRequest({ url: `https://c.example.com/${path}`, contentType: 'video/mp4' })!;

describe('tab media store', () => {
  beforeEach(() => fakeBrowser.reset());

  it('returns an empty list for unknown tabs', async () => {
    expect(await readTabMedia(1)).toEqual([]);
  });

  it('keeps tabs isolated', async () => {
    await updateTabMedia(1, list => mergeMedia(list, mediaAt('a.mp4')));
    await updateTabMedia(2, list => mergeMedia(list, mediaAt('b.mp4')));
    expect((await readTabMedia(1)).map(m => m.key)).toEqual(['https://c.example.com/a.mp4']);
  });

  it('does not lose updates fired concurrently (pages load many videos at once)', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateTabMedia(7, list => mergeMedia(list, mediaAt(`${i}.mp4`)))));
    expect(await readTabMedia(7)).toHaveLength(20);
  });

  it('keeps working after an update callback throws', async () => {
    await expect(updateTabMedia(3, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await updateTabMedia(3, list => mergeMedia(list, mediaAt('ok.mp4')));
    expect(await readTabMedia(3)).toHaveLength(1);
  });

  it('clears a tab', async () => {
    await updateTabMedia(4, list => mergeMedia(list, mediaAt('a.mp4')));
    await clearTabMedia(4);
    expect(await readTabMedia(4)).toEqual([]);
  });
});
