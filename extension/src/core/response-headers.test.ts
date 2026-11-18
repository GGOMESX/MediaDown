import { describe, it, expect } from 'vitest';
import { toObservedResponse } from './response-headers';

describe('toObservedResponse', () => {
  it('reads content-type and content-length case-insensitively', () => {
    const observed = toObservedResponse('https://c.example.com/a.mp4', [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'content-length', value: '1234' },
    ]);
    expect(observed).toEqual({ url: 'https://c.example.com/a.mp4', contentType: 'video/mp4', contentLength: 1234 });
  });

  it('prefers the total size from content-range on partial responses', () => {
    const observed = toObservedResponse('https://c.example.com/a.mp4', [
      { name: 'content-length', value: '2' },
      { name: 'content-range', value: 'bytes 0-1/987654321' },
    ]);
    expect(observed.contentLength).toBe(987654321);
  });

  it('ignores unknown totals and malformed numbers', () => {
    const observed = toObservedResponse('https://c.example.com/a.mp4', [
      { name: 'content-length', value: 'abc' },
      { name: 'content-range', value: 'bytes 0-1/*' },
    ]);
    expect(observed.contentLength).toBeUndefined();
  });

  it('handles missing headers', () => {
    expect(toObservedResponse('https://c.example.com/a', undefined)).toEqual({ url: 'https://c.example.com/a' });
  });
});
