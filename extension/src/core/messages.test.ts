import { describe, it, expect } from 'vitest';
import { parseRequest } from './messages';

describe('parseRequest', () => {
  it('accepts a well-formed download request', () => {
    expect(parseRequest({ type: 'download', tabId: 3, mediaKey: 'https://c.example.com/a.mp4' }))
      .toEqual({ type: 'download', tabId: 3, mediaKey: 'https://c.example.com/a.mp4' });
  });

  it.each([
    [null],
    [{ type: 'download', tabId: '3', mediaKey: 'k' }],
    [{ type: 'download', tabId: -1, mediaKey: 'k' }],
    [{ type: 'download', tabId: 3 }],
    [{ type: 'delete-everything' }],
  ])('rejects malformed input %j', input => {
    expect(parseRequest(input)).toBeNull();
  });
});
