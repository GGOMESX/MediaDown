export type DownloadError = 'forbidden' | 'expired' | 'network' | 'diskFull' | 'fileAccess' | 'canceled' | 'unknown';

const ERROR_BY_INTERRUPT_REASON: Record<string, DownloadError> = {
  SERVER_FORBIDDEN: 'forbidden',
  SERVER_UNAUTHORIZED: 'forbidden',
  SERVER_CERT_PROBLEM: 'forbidden',
  SERVER_BAD_CONTENT: 'expired',
  SERVER_NO_RANGE: 'network',
  SERVER_FAILED: 'network',
  SERVER_CONTENT_LENGTH_MISMATCH: 'network',
  SERVER_CROSS_ORIGIN_REDIRECT: 'forbidden',
  NETWORK_FAILED: 'network',
  NETWORK_TIMEOUT: 'network',
  NETWORK_DISCONNECTED: 'network',
  NETWORK_SERVER_DOWN: 'network',
  NETWORK_INVALID_REQUEST: 'network',
  FILE_NO_SPACE: 'diskFull',
  FILE_TOO_LARGE: 'diskFull',
  FILE_ACCESS_DENIED: 'fileAccess',
  FILE_NAME_TOO_LONG: 'fileAccess',
  FILE_BLOCKED: 'fileAccess',
  FILE_SECURITY_CHECK_FAILED: 'fileAccess',
  FILE_FAILED: 'fileAccess',
  USER_CANCELED: 'canceled',
  USER_SHUTDOWN: 'network',
  CRASH: 'network',
};

/** Maps chrome.downloads InterruptReason to the few cases the user can act on. */
export function toDownloadError(interruptReason: string): DownloadError {
  return ERROR_BY_INTERRUPT_REASON[interruptReason] ?? 'unknown';
}

export function isRetryable(error: DownloadError): boolean {
  return error === 'network' || error === 'unknown';
}
