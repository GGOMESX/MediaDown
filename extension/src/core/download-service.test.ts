import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { startDownload, startRecording, controlJob } from './download-service';
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
    await saveSettings({ folder: '', askWhereToSave: true, preset: 'best', subtitles: true, keepHistory: true });
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
    await saveSettings({ folder: 'Cursos', askWhereToSave: false, preset: 'max1080p', subtitles: true, keepHistory: true });
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
      quality: { mode: 'maxHeight', height: 1080 },
      subtitles: true,
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

  it('uses the quality picked in the popup over the default preset', async () => {
    await seed(HLS);
    const { gateway, sent } = fakeCompanion();
    await startDownload({ type: 'download', tabId: TAB, mediaKey: HLS.key, quality: { mode: 'audioMp3' } }, gateway);
    expect(sent[0]).toMatchObject({ quality: { mode: 'audioMp3' } });
  });

  it('refuses live streams', async () => {
    await seed({ ...HLS, live: true });
    const { gateway, sent } = fakeCompanion();
    expect(await startDownload({ type: 'download', tabId: TAB, mediaKey: HLS.key }, gateway)).toEqual({ ok: false, reason: 'live' });
    expect(sent).toEqual([]);
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

describe('startDownload of subtitle files', () => {
  let download: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeBrowser.reset();
    download = vi.fn().mockResolvedValue(55);
    fakeBrowser.downloads.download = download as never;
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: TAB, title: 'Aula 2', url: 'https://curso.example.com/2' }) as never;
  });

  it('converts WebVTT to SRT and saves it named after the file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOlá\n')));
    const subtitle = media({ kind: 'subtitle', key: 'https://c.example.com/legendas/pt-BR.vtt', url: 'https://c.example.com/legendas/pt-BR.vtt', contentType: 'text/vtt' });
    await seed(subtitle);

    const response = await startDownload({ type: 'download', tabId: TAB, mediaKey: subtitle.key }, fakeCompanion().gateway);

    expect(response).toEqual({ ok: true, via: 'browser', downloadId: 55 });
    const { url, filename } = download.mock.calls[0]![0] as { url: string; filename: string };
    expect(filename).toBe('Media Downloader/pt-BR.srt');
    expect(decodeURIComponent(url.split(',')[1]!)).toBe('\uFEFF1\n00:00:01,000 --> 00:00:02,000\nOlá\n');
    vi.unstubAllGlobals();
  });

  it('downloads .srt files directly', async () => {
    const subtitle = media({ kind: 'subtitle', key: 'https://c.example.com/s/aula.srt', url: 'https://c.example.com/s/aula.srt?t=1', contentType: '' });
    await seed(subtitle);
    await startDownload({ type: 'download', tabId: TAB, mediaKey: subtitle.key }, fakeCompanion().gateway);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://c.example.com/s/aula.srt?t=1', filename: 'Media Downloader/aula.srt' }));
  });

  it('fails cleanly when the file has no cues', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('WEBVTT\n')));
    const subtitle = media({ kind: 'subtitle', key: 'https://c.example.com/x.vtt', url: 'https://c.example.com/x.vtt', contentType: 'text/vtt' });
    await seed(subtitle);
    expect(await startDownload({ type: 'download', tabId: TAB, mediaKey: subtitle.key }, fakeCompanion().gateway)).toEqual({ ok: false, reason: 'failed' });
    expect(download).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('startRecording', () => {
  const LIVE = media({ kind: 'hls', live: true, key: 'https://live.example.com/canal/index.m3u8', url: 'https://live.example.com/canal/index.m3u8?t=1' });

  beforeEach(() => {
    fakeBrowser.reset();
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: TAB, title: 'Canal Ao Vivo', url: 'https://tv.example.com/ao-vivo' }) as never;
  });

  it('asks the companion to record, named after the page and the start time', async () => {
    await seed(LIVE);
    const { gateway, sent } = fakeCompanion();

    const response = await startRecording({ type: 'record', tabId: TAB, mediaKey: LIVE.key }, gateway, new Date(2026, 10, 20, 21, 30));

    expect(response).toMatchObject({ ok: true, via: 'companion' });
    expect(sent).toEqual([{
      type: 'record',
      jobId: (response as { jobId: string }).jobId,
      url: LIVE.url,
      referer: 'https://tv.example.com/ao-vivo',
      userAgent: navigator.userAgent,
      folder: 'Media Downloader',
      fileName: 'Canal Ao Vivo — gravação 2026-11-20 21h30',
      variant: undefined,
    }]);
    expect((await readTabMedia(TAB))[0]?.job).toMatchObject({ state: 'queued', recording: true });
  });

  it('records the variant matching the chosen resolution', async () => {
    await seed({ ...LIVE, variantHeights: [240, 1080, 720] });
    const { gateway, sent } = fakeCompanion();
    await startRecording({ type: 'record', tabId: TAB, mediaKey: LIVE.key, quality: { mode: 'maxHeight', height: 720 } }, gateway);
    expect(sent[0]).toMatchObject({ type: 'record', variant: 2 });
  });

  it.each([
    ['protected lives', { protection: 'protected' as const }, 'protected'],
    ['recorded (non-live) streams', { live: false }, 'notLive'],
  ])('refuses %s', async (_label, overrides, reason) => {
    await seed({ ...LIVE, ...overrides });
    const { gateway, sent } = fakeCompanion();
    expect(await startRecording({ type: 'record', tabId: TAB, mediaKey: LIVE.key }, gateway)).toEqual({ ok: false, reason });
    expect(sent).toEqual([]);
  });

  it('explains when the companion is missing', async () => {
    await seed(LIVE);
    const { gateway } = fakeCompanion({ state: 'notInstalled' });
    expect(await startRecording({ type: 'record', tabId: TAB, mediaKey: LIVE.key }, gateway)).toEqual({ ok: false, reason: 'companionNotInstalled' });
  });

  it('stops a recording through its job', async () => {
    await seed({ ...LIVE, job: { id: 't5-rec', state: 'running', recording: true } });
    const { gateway, sent } = fakeCompanion();
    expect(await controlJob('stop', TAB, LIVE.key, gateway)).toBe(true);
    expect(sent).toEqual([{ type: 'stop', jobId: 't5-rec' }]);
  });
});
