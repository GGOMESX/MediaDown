import { browser } from 'wxt/browser';
import { sanitizeFolder } from './file-name';

export interface Settings {
  /** Subfolder inside the browser's Downloads folder; the downloads API cannot write elsewhere. */
  folder: string;
  askWhereToSave: boolean;
  /** Quality for companion downloads (HLS/DASH and files the browser could not fetch). */
  preset: Preset;
}

export const PRESETS = ['best', 'max1080p', 'audioMp3'] as const;
export type Preset = (typeof PRESETS)[number];

export const DEFAULT_SETTINGS: Readonly<Settings> = { folder: 'Media Downloader', askWhereToSave: false, preset: 'best' };
const STORAGE_KEY = 'settings';

export function normalizeSettings(raw: unknown): Settings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    folder: typeof input.folder === 'string' ? sanitizeFolder(input.folder) : DEFAULT_SETTINGS.folder,
    askWhereToSave: typeof input.askWhereToSave === 'boolean' ? input.askWhereToSave : DEFAULT_SETTINGS.askWhereToSave,
    preset: (PRESETS as readonly unknown[]).includes(input.preset) ? (input.preset as Preset) : DEFAULT_SETTINGS.preset,
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
