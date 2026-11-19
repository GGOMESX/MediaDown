import { browser } from 'wxt/browser';
import type { DownloadError } from './download-errors';
import type { DownloadRefusal } from './messages';

export type MessageKey = Parameters<typeof browser.i18n.getMessage>[0];

export function t(key: MessageKey, substitutions?: string | string[]): string {
  return browser.i18n.getMessage(key, substitutions) || key;
}

export const DOWNLOAD_ERROR_MESSAGE: Record<DownloadError, MessageKey> = {
  forbidden: 'errorForbidden',
  expired: 'errorExpired',
  network: 'errorNetwork',
  diskFull: 'errorDiskFull',
  fileAccess: 'errorFileAccess',
  canceled: 'errorCanceled',
  unknown: 'errorUnknown',
};

export const REFUSAL_MESSAGE: Record<DownloadRefusal, MessageKey> = {
  notFound: 'refusalNotFound',
  protected: 'drmExplanation',
  needsCompanion: 'needsCompanion',
  failed: 'refusalFailed',
};
