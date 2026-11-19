import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { startDownload, controlJob } from './download-service';
import type { CompanionGateway, HostRequest } from './companion-client';
import type { CompanionStatus } from './messages';
import { updateTabMedia, readTabMedia } from './tab-media-store';
import { mergeMedia } from './tab-media';
import { saveSettings } from './settings';
import type { DetectedMedia } from './media-classifier';

const TAB = 5;

function fakeCompanion(status: CompanionStatus = { state: 'ready' }) {
  const sent: HostRequest[] = [];
  const gateway: CompanionGateway = {
    status: async () => status,
    send: async request => {
      sent.push(request);
    },
  };
  return { gateway, sent };
}

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

    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://c.example.com/aula.mp4' }, fakeCompanion().gateway);

    expect(response).toEqual({ ok: true, via: 'browser', downloadId: 99 });
    expect(download).toHaveBeenCalledWith({
      url: 'https://c.example.com/aula.mp4?token=1',
      filename: 'Media Downloader/aula.mp4',
      saveAs: false,
      conflictAction: 'uniquify',
    });
    expect((await readTabMedia(TAB))[0]?.downloadId).toBe(99);
  });

  it('honors the "ask where to save" setting', async () => {
    await saveSettings({ folder: '', askWhereToSave: true, preset: 'best' });
    await seed(media({}));

    await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://c.example.com/aula.mp4' }, fakeCompanion().gateway);

    expect(download).toHaveBeenCalledWith(expect.objectContaining({ filename: 'aula.mp4', saveAs: true }));
  });

  it.each([
    ['protected', media({ protection: 'protected' })],
    ['unknown protection', media({ protection: 'unknown' })],
    ['protected HLS', media({ kind: 'hls', protection: 'protected' })],
  ])('refuses %s media without calling the downloads API or the companion', async (_label, item) => {
    const companionDouble = fakeCompanion();
    await seed(item);
    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: item.key }, companionDouble.gateway);
    expect(response).toEqual({ ok: false, reason: 'protected' });
    expect(download).not.toHaveBeenCalled();
    expect(companionDouble.sent).toEqual([]);
  });

  it('refuses media that is not in the tab list (cannot download arbitrary URLs)', async () => {
    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://evil.example.com/x.mp4' }, fakeCompanion().gateway);
    expect(response).toEqual({ ok: false, reason: 'notFound' });
  });

  it('resumes an interrupted download instead of starting over', async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    fakeBrowser.downloads.search = vi.fn().mockResolvedValue([{ id: 7, canResume: true }]) as never;
    fakeBrowser.downloads.resume = resume as never;
    await seed(media({ downloadId: 7 }));

    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://c.example.com/aula.mp4' }, fakeCompanion().gateway);

    expect(response).toEqual({ ok: true, via: 'browser', downloadId: 7 });
    expect(resume).toHaveBeenCalledWith(7);
    expect(download).not.toHaveBeenCalled();
  });

  it('retries with an ASCII name when the system rejects accented file names', async () => {
    download.mockRejectedValueOnce(new Error('Invalid filename')).mockResolvedValueOnce(100);
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: TAB, title: 'Introdução' }) as never;
    await seed(media({ url: 'https://c.example.com/3f9a8c2e1b7d4a6f9e0c.mp4', key: 'https://c.example.com/3f9a8c2e1b7d4a6f9e0c.mp4' }));

    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://c.example.com/3f9a8c2e1b7d4a6f9e0c.mp4' }, fakeCompanion().gateway);

    expect(response).toEqual({ ok: true, via: 'browser', downloadId: 100 });
    expect(download).toHaveBeenNthCalledWith(1, expect.objectContaining({ filename: 'Media Downloader/Introdução.mp4' }));
    expect(download).toHaveBeenNthCalledWith(2, expect.objectContaining({ filename: 'Media Downloader/Introducao.mp4' }));
  });

  it('reports failure when the downloads API rejects', async () => {
    download.mockRejectedValue(new Error('Invalid filename'));
    await seed(media({}));
    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://c.example.com/aula.mp4' }, fakeCompanion().gateway);
    expect(response).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('startDownload via companion', () => {
  const HLS = media({ kind: 'hls', key: 'https://c.example.com/aula/master.m3u8', url: 'https://c.example.com/aula/master.m3u8?sig=1' });

  beforeEach(() => {
    fakeBrowser.reset();
    fakeBrowser.downloads.download = vi.fn() as never;
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: TAB, title: 'Aula 3: Ownership', url: 'https://curso.example.com/aula-3' }) as never;
  });

  it('sends HLS jobs to the companion with referer, title-based name and preset', async () => {
    await saveSettings({ folder: 'Cursos', askWhereToSave: false, preset: 'max1080p' });
    await seed(HLS);
    const { gateway, sent } = fakeCompanion();

    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: HLS.key }, gateway);

    expect(response).toMatchObject({ ok: true, via: 'companion' });
    const jobId = (response as { jobId: string }).jobId;
    expect(jobId).toMatch(new RegExp(`^t${TAB}-`));
    expect(sent).toEqual([{
      type: 'download',
      jobId,
      url: 'https://c.example.com/aula/master.m3u8?sig=1',
      referer: 'https://curso.example.com/aula-3',
      userAgent: navigator.userAgent,
      folder: 'Cursos',
      fileName: 'Aula 3_ Ownership',
      preset: 'max1080p',
    }]);
    expect((await readTabMedia(TAB))[0]?.job).toEqual({ id: jobId, state: 'queued' });
    expect(fakeBrowser.downloads.download).not.toHaveBeenCalled();
  });

  it.each([
    ['notInstalled', 'companionNotInstalled'],
    ['engineMissing', 'companionEngineMissing'],
    ['incompatible', 'companionIncompatible'],
  ] as const)('explains a %s companion instead of failing silently', async (state, reason) => {
    await seed(HLS);
    const { gateway, sent } = fakeCompanion({ state });
    expect(await startDownload({ type: 'download', tabId: TAB, mediaKey: HLS.key }, gateway)).toEqual({ ok: false, reason });
    expect(sent).toEqual([]);
    expect((await readTabMedia(TAB))[0]?.job).toBeUndefined();
  });

  it('routes a progressive file to the companion on request (hotlink fallback)', async () => {
    await seed(media({}));
    const { gateway, sent } = fakeCompanion();
    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: 'https://c.example.com/aula.mp4', via: 'companion' }, gateway);
    expect(response).toMatchObject({ ok: true, via: 'companion' });
    expect(sent[0]).toMatchObject({ type: 'download', url: 'https://c.example.com/aula.mp4?token=1' });
  });

  it('omits the referer for non-web pages', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: TAB, title: 'x', url: 'chrome://newtab' }) as never;
    await seed(HLS);
    const { gateway, sent } = fakeCompanion();
    await startDownload({ type: 'download', tabId: TAB, mediaKey: HLS.key }, gateway);
    expect(sent[0]).toMatchObject({ referer: undefined });
  });
});

describe('controlJob', () => {
  beforeEach(() => fakeBrowser.reset());

  it('forwards cancel/reveal for the media job', async () => {
    await seed(media({ job: { id: 't5-abc', state: 'running' } }));
    const { gateway, sent } = fakeCompanion();
    expect(await controlJob('cancel', TAB, 'https://c.example.com/aula.mp4', gateway)).toBe(true);
    expect(sent).toEqual([{ type: 'cancel', jobId: 't5-abc' }]);
  });

  it('does nothing for media without a job', async () => {
    await seed(media({}));
    const { gateway, sent } = fakeCompanion();
    expect(await controlJob('reveal', TAB, 'https://c.example.com/aula.mp4', gateway)).toBe(false);
    expect(sent).toEqual([]);
  });
});
