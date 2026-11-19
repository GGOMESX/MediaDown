import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { startDownload } from './download-service';
import { updateTabMedia, readTabMedia } from './tab-media-store';
import { mergeMedia } from './tab-media';
import { saveSettings } from './settings';
import type { DetectedMedia } from './media-classifier';

const TAB = 5;

function media(overrides: Partial<DetectedMedia>): DetectedMedia {
  return {
    key: 'https://c.example.com/aula.mp4',
    url: 'https://c.example.com/aula.mp4?token=1',
    kind: 'progressive',
    contentType: 'video/mp4',
    protection: 'clear',
    detectedAt: 1,
    ...overrides,
  };
}

async function seed(item: DetectedMedia) {
  await updateTabMedia(TAB, list => mergeMedia(list, item));
}

describe('startDownload', () => {
  let download: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeBrowser.reset();
    download = vi.fn().mockResolvedValue(99);
    fakeBrowser.downloads.download = download as never;
    fakeBrowser.downloads.search = vi.fn().mockResolvedValue([]) as never;
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: TAB, title: 'Curso' }) as never;
  });

  it('downloads clear progressive media into the configured folder', async () => {
    await seed(media({}));

    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://c.example.com/aula.mp4' });

    expect(response).toEqual({ ok: true, downloadId: 99 });
    expect(download).toHaveBeenCalledWith({
      url: 'https://c.example.com/aula.mp4?token=1',
      filename: 'Media Downloader/aula.mp4',
      saveAs: false,
      conflictAction: 'uniquify',
    });
    expect((await readTabMedia(TAB))[0]?.downloadId).toBe(99);
  });

  it('honors the "ask where to save" setting', async () => {
    await saveSettings({ folder: '', askWhereToSave: true });
    await seed(media({}));

    await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://c.example.com/aula.mp4' });

    expect(download).toHaveBeenCalledWith(expect.objectContaining({ filename: 'aula.mp4', saveAs: true }));
  });

  it.each([
    ['protected', media({ protection: 'protected' }), 'protected'],
    ['unknown protection', media({ protection: 'unknown' }), 'protected'],
    ['HLS', media({ kind: 'hls', protection: 'clear' }), 'needsCompanion'],
  ])('refuses %s media without calling the downloads API', async (_label, item, reason) => {
    await seed(item);
    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: item.key });
    expect(response).toEqual({ ok: false, reason });
    expect(download).not.toHaveBeenCalled();
  });

  it('refuses media that is not in the tab list (cannot download arbitrary URLs)', async () => {
    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://evil.example.com/x.mp4' });
    expect(response).toEqual({ ok: false, reason: 'notFound' });
  });

  it('resumes an interrupted download instead of starting over', async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    fakeBrowser.downloads.search = vi.fn().mockResolvedValue([{ id: 7, canResume: true }]) as never;
    fakeBrowser.downloads.resume = resume as never;
    await seed(media({ downloadId: 7 }));

    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://c.example.com/aula.mp4' });

    expect(response).toEqual({ ok: true, downloadId: 7 });
    expect(resume).toHaveBeenCalledWith(7);
    expect(download).not.toHaveBeenCalled();
  });

  it('retries with an ASCII name when the system rejects accented file names', async () => {
    download.mockRejectedValueOnce(new Error('Invalid filename')).mockResolvedValueOnce(100);
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: TAB, title: 'Introdução' }) as never;
    await seed(media({ url: 'https://c.example.com/3f9a8c2e1b7d4a6f9e0c.mp4', key: 'https://c.example.com/3f9a8c2e1b7d4a6f9e0c.mp4' }));

    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://c.example.com/3f9a8c2e1b7d4a6f9e0c.mp4' });

    expect(response).toEqual({ ok: true, downloadId: 100 });
    expect(download).toHaveBeenNthCalledWith(1, expect.objectContaining({ filename: 'Media Downloader/Introdução.mp4' }));
    expect(download).toHaveBeenNthCalledWith(2, expect.objectContaining({ filename: 'Media Downloader/Introducao.mp4' }));
  });

  it('reports failure when the downloads API rejects', async () => {
    download.mockRejectedValue(new Error('Invalid filename'));
    await seed(media({}));
    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://c.example.com/aula.mp4' });
    expect(response).toEqual({ ok: false, reason: 'failed' });
  });
});
