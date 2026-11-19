import { describe, it, expect } from 'vitest';
import { toDownloadError } from './download-errors';

describe('toDownloadError', () => {
  it.each([
    ['SERVER_FORBIDDEN', 'forbidden'],
    ['SERVER_UNAUTHORIZED', 'forbidden'],
    ['SERVER_BAD_CONTENT', 'expired'],
    ['NETWORK_FAILED', 'network'],
    ['NETWORK_TIMEOUT', 'network'],
    ['NETWORK_DISCONNECTED', 'network'],
    ['FILE_NO_SPACE', 'diskFull'],
    ['FILE_ACCESS_DENIED', 'fileAccess'],
    ['FILE_NAME_TOO_LONG', 'fileAccess'],
    ['USER_CANCELED', 'canceled'],
    ['SOMETHING_NEW', 'unknown'],
  ])('maps %s to %s', (reason, expected) => {
    expect(toDownloadError(reason)).toBe(expected);
  });

  it('marks network errors as retryable and cancellations as not', async () => {
    const { isRetryable } = await import('./download-errors');
    expect(isRetryable('network')).toBe(true);
    expect(isRetryable('canceled')).toBe(false);
  });
});
