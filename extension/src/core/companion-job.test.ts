import { describe, it, expect } from 'vitest';
import { newJobId, tabIdFromJobId, parseHostEvent, applyJobStarted, applyHostEvent, failActiveJobs } from './companion-job';
import type { DetectedMedia } from './media-classifier';

const base: DetectedMedia = {
  key: 'https://c.example.com/aula/master.m3u8',
  url: 'https://c.example.com/aula/master.m3u8?sig=1',
  kind: 'hls',
  contentType: '',
  protection: 'clear',
  detectedAt: 1,
};

describe('job ids', () => {
  it('encode the tab id and only safe characters', () => {
    const id = newJobId(42, '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed');
    expect(id).toBe('t42-1b9d6bcdbbfd4b2d');
    expect(tabIdFromJobId(id)).toBe(42);
  });

  it('reject foreign ids', () => {
    expect(tabIdFromJobId('../x')).toBeNull();
    expect(tabIdFromJobId('t1-')).toBeNull();
  });
});

describe('parseHostEvent', () => {
  it('accepts known events', () => {
    expect(parseHostEvent({ type: 'done', jobId: 't1-a', fileName: 'a.mp4' })).not.toBeNull();
    expect(parseHostEvent({ type: 'hello', protocolVersion: 1, hostVersion: '0.1.0', engineReady: true })).not.toBeNull();
  });

  it('rejects malformed events', () => {
    expect(parseHostEvent(null)).toBeNull();
    expect(parseHostEvent({ type: 'progress' })).toBeNull();
    expect(parseHostEvent({ type: 'rm -rf', jobId: 'x' })).toBeNull();
  });

  it('downgrades unknown error codes from a newer host to "unknown"', () => {
    expect(parseHostEvent({ type: 'failed', jobId: 't1-a', error: 'quantum', detail: '' })).toMatchObject({ error: 'unknown' });
  });
});

describe('job lifecycle', () => {
  const started = applyJobStarted([{ ...base, downloadId: 9 }], base.key, 't1-abc');

  it('starts queued and replaces any previous browser download', () => {
    expect(started[0]?.job).toEqual({ id: 't1-abc', state: 'queued' });
    expect(started[0]?.downloadId).toBeUndefined();
  });

  it('tracks progress, keeping the last known total', () => {
    let list = applyHostEvent(started, { type: 'started', jobId: 't1-abc' });
    list = applyHostEvent(list, { type: 'progress', jobId: 't1-abc', downloadedBytes: 10, totalBytes: 100, speed: 5, etaSeconds: 18 });
    list = applyHostEvent(list, { type: 'progress', jobId: 't1-abc', downloadedBytes: 50, totalBytes: null, speed: null, etaSeconds: null });
    expect(list[0]?.job).toMatchObject({ state: 'running', downloadedBytes: 50, totalBytes: 100, speed: undefined });
  });

  it('records completion and failures', () => {
    expect(applyHostEvent(started, { type: 'done', jobId: 't1-abc', fileName: 'Aula.mp4' })[0]?.job).toMatchObject({ state: 'done', fileName: 'Aula.mp4' });
    expect(applyHostEvent(started, { type: 'failed', jobId: 't1-abc', error: 'forbidden', detail: '403' })[0]?.job).toMatchObject({ state: 'failed', error: 'forbidden' });
  });

  it('ignores events for other jobs', () => {
    expect(applyHostEvent(started, { type: 'done', jobId: 't1-other', fileName: 'x' })).toEqual(started);
  });

  it('fails only active jobs when the host disconnects', () => {
    const done = applyHostEvent(applyJobStarted([{ ...base, key: 'k2' }], 'k2', 't1-done'), { type: 'done', jobId: 't1-done', fileName: 'x' });
    const list = failActiveJobs([...started, ...done], 'disconnected');
    expect(list.map(m => m.job?.state)).toEqual(['failed', 'done']);
    expect(list[0]?.job?.error).toBe('disconnected');
  });
});
