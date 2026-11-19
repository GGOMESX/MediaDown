import { browser } from 'wxt/browser';
import type { DownloadRefusal } from './messages';
import type { TransferError } from './transfer-view';
import type { Preset } from './settings';

export type MessageKey = Parameters<typeof browser.i18n.getMessage>[0];

export function t(key: MessageKey, substitutions?: string | string[]): string {
  return browser.i18n.getMessage(key, substitutions) || key;
}

export const TRANSFER_ERROR_MESSAGE: Record<TransferError, MessageKey> = {
  forbidden: 'errorForbidden',
  expired: 'errorExpired',
  network: 'errorNetwork',
  diskFull: 'errorDiskFull',
  fileAccess: 'errorFileAccess',
  canceled: 'errorCanceled',
  unknown: 'errorUnknown',
  drm: 'errorDrm',
  engineMissing: 'errorEngineMissing',
  invalidRequest: 'errorInvalidRequest',
  disconnected: 'errorDisconnected',
};

export const REFUSAL_MESSAGE: Record<DownloadRefusal, MessageKey> = {
  notFound: 'refusalNotFound',
  protected: 'drmExplanation',
  live: 'liveNotSupported',
  failed: 'refusalFailed',
  companionNotInstalled: 'companionNotInstalled',
  companionEngineMissing: 'companionEngineMissing',
  companionIncompatible: 'companionIncompatible',
};

export const PRESET_LABEL: Record<Preset, MessageKey> = {
  best: 'presetBest',
  max1080p: 'presetMax1080p',
  audioMp3: 'presetAudioMp3',
};
