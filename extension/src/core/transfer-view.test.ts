import { describe, it, expect } from 'vitest';
import { toTransferView, primaryAction } from './transfer-view';
import type { DetectedMedia } from './media-classifier';

const file: DetectedMedia = { key: 'k', url: 'https://c.example.com/a.mp4', kind: 'progressive', contentType: 'video/mp4', protection: 'clear', detectedAt: 1 };
const stream: DetectedMedia = { ...file, kind: 'hls' };

describe('toTransferView', () => {
  it('is idle when nothing was started', () => {
    expect(toTransferView(file, undefined)).toEqual({ via: 'browser', state: 'idle' });
  });

  it('maps browser downloads', () => {
    const view = toTransferView({ ...file, downloadId: 1 }, { state: 'interrupted', bytesReceived: 5, error: 'forbidden' });
    expect(view).toMatchObject({ via: 'browser', state: 'failed', error: 'forbidden' });
  });

  it('maps companion jobs, which take precedence', () => {
    const view = toTransferView({ ...stream, job: { id: 't1-a', state: 'running', downloadedBytes: 3, totalBytes: 9, speed: 1 } }, undefined);
    expect(view).toEqual({ via: 'companion', state: 'running', receivedBytes: 3, totalBytes: 9, speed: 1, error: undefined });
  });
});

describe('primaryAction', () => {
  it('offers nothing for protected media', () => {
    expect(primaryAction({ ...file, protection: 'protected' }, { via: 'browser', state: 'idle' }, true)).toBe('none');
  });

  it('offers recording for live streams, only with the companion', () => {
    const live = { ...stream, live: true };
    expect(primaryAction(live, { via: 'browser', state: 'idle' }, true)).toBe('record');
    expect(primaryAction(live, { via: 'browser', state: 'idle' }, false)).toBe('none');
    expect(primaryAction(live, { via: 'companion', state: 'running', recording: true }, true)).toBe('stopRecording');
    expect(primaryAction(live, { via: 'companion', state: 'done', recording: true }, true)).toBe('showInFolder');
    expect(primaryAction(live, { via: 'companion', state: 'failed', recording: true, error: 'network' }, true)).toBe('record');
  });

  it('never offers recording for protected lives', () => {
    expect(primaryAction({ ...stream, live: true, protection: 'protected' }, { via: 'browser', state: 'idle' }, true)).toBe('none');
  });

  it('exposes recording details in the view', () => {
    const view = toTransferView({ ...stream, job: { id: 't1-r', state: 'running', recording: true, elapsedSeconds: 30, downloadedBytes: 10 } }, undefined);
    expect(view).toMatchObject({ recording: true, elapsedSeconds: 30, receivedBytes: 10 });
  });

  it('follows the transfer state', () => {
    expect(primaryAction(file, { via: 'browser', state: 'idle' }, false)).toBe('download');
    expect(primaryAction(file, { via: 'companion', state: 'queued' }, true)).toBe('cancel');
    expect(primaryAction(file, { via: 'companion', state: 'done' }, true)).toBe('showInFolder');
  });

  it('offers the companion when the browser hit hotlink protection', () => {
    const failed = { via: 'browser', state: 'failed', error: 'forbidden' } as const;
    expect(primaryAction(file, failed, true)).toBe('downloadWithApp');
    expect(primaryAction(file, failed, false)).toBe('downloadAgain');
  });

  it('suggests retry only for transient errors', () => {
    expect(primaryAction(file, { via: 'companion', state: 'failed', error: 'network' }, true)).toBe('retry');
    expect(primaryAction(file, { via: 'companion', state: 'failed', error: 'disconnected' }, true)).toBe('retry');
    expect(primaryAction(file, { via: 'companion', state: 'failed', error: 'canceled' }, true)).toBe('downloadAgain');
  });
});
