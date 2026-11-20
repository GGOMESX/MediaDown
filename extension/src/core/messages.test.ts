import { describe, it, expect } from 'vitest';
import { parseRequest } from './messages';

describe('parseRequest', () => {
  it('accepts well-formed download requests, optionally choosing the route', () => {
    expect(parseRequest({ type: 'download', tabId: 3, mediaKey: 'k' })).toEqual({ type: 'download', tabId: 3, mediaKey: 'k' });
    expect(parseRequest({ type: 'download', tabId: 3, mediaKey: 'k', via: 'companion' })).toEqual({ type: 'download', tabId: 3, mediaKey: 'k', via: 'companion' });
  });

  it('accepts a per-video quality choice', () => {
    expect(parseRequest({ type: 'download', tabId: 3, mediaKey: 'k', quality: { mode: 'maxHeight', height: 720 } }))
      .toEqual({ type: 'download', tabId: 3, mediaKey: 'k', quality: { mode: 'maxHeight', height: 720 } });
  });

  it('accepts a recording resolution but not audio-only', () => {
    expect(parseRequest({ type: 'record', tabId: 2, mediaKey: 'k', quality: { mode: 'maxHeight', height: 720 } }))
      .toEqual({ type: 'record', tabId: 2, mediaKey: 'k', quality: { mode: 'maxHeight', height: 720 } });
    expect(parseRequest({ type: 'record', tabId: 2, mediaKey: 'k', quality: { mode: 'audioMp3' } })).toBeNull();
  });

  it('accepts record and stop requests', () => {
    expect(parseRequest({ type: 'record', tabId: 2, mediaKey: 'k' })).toEqual({ type: 'record', tabId: 2, mediaKey: 'k' });
    expect(parseRequest({ type: 'stop', tabId: 2, mediaKey: 'k', extra: true })).toEqual({ type: 'stop', tabId: 2, mediaKey: 'k' });
  });

  it('accepts cancel, reveal and status requests', () => {
    expect(parseRequest({ type: 'cancel', tabId: 1, mediaKey: 'k' })).toEqual({ type: 'cancel', tabId: 1, mediaKey: 'k' });
    expect(parseRequest({ type: 'reveal', tabId: 1, mediaKey: 'k' })).toEqual({ type: 'reveal', tabId: 1, mediaKey: 'k' });
    expect(parseRequest({ type: 'companionStatus', extra: 1 })).toEqual({ type: 'companionStatus' });
  });

  it.each([
    [null],
    [{ type: 'download', tabId: '3', mediaKey: 'k' }],
    [{ type: 'download', tabId: -1, mediaKey: 'k' }],
    [{ type: 'download', tabId: 3 }],
    [{ type: 'download', tabId: 3, mediaKey: 'k', via: 'shell' }],
    [{ type: 'reveal', tabId: 3, mediaKey: '' }],
    [{ type: 'download', tabId: 3, mediaKey: 'k', quality: { mode: 'maxHeight', height: 5 } }],
    [{ type: 'download', tabId: 3, mediaKey: 'k', quality: 'best' }],
    [{ type: 'delete-everything' }],
  ])('rejects malformed input %j', input => {
    expect(parseRequest(input)).toBeNull();
  });
});
