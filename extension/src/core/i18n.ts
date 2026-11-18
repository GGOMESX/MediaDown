import { browser } from 'wxt/browser';

export type MessageKey =
  | 'popupTitle' | 'emptyState' | 'emptyHint' | 'kindProgressive' | 'kindHls' | 'kindDash'
  | 'protectionClear' | 'protectionProtected' | 'protectionUnknown' | 'copyUrl' | 'copied'
  | 'drmExplanation' | 'unsupportedPage';

export function t(key: MessageKey, substitutions?: string | string[]): string {
  return browser.i18n.getMessage(key, substitutions) || key;
}
