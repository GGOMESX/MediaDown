import { browser } from 'wxt/browser';
import { sanitizeFolder } from './file-name';

export interface Settings {
  /** Subfolder inside the browser's Downloads folder; the downloads API cannot write elsewhere. */
  folder: string;
  askWhereToSave: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = { folder: 'Media Downloader', askWhereToSave: false };
const STORAGE_KEY = 'settings';

export function normalizeSettings(raw: unknown): Settings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    folder: typeof input.folder === 'string' ? sanitizeFolder(input.folder) : DEFAULT_SETTINGS.folder,
    askWhereToSave: typeof input.askWhereToSave === 'boolean' ? input.askWhereToSave : DEFAULT_SETTINGS.askWhereToSave,
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return normalizeSettings(stored[STORAGE_KEY]);
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const normalized = normalizeSettings(settings);
  await browser.storage.local.set({ [STORAGE_KEY]: normalized });
  return normalized;
}
