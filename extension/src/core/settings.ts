import { browser } from 'wxt/browser';
import { sanitizeFolder } from './file-name';

export interface Settings {
  /** Subfolder inside the browser's Downloads folder; the downloads API cannot write elsewhere. */
  folder: string;
  askWhereToSave: boolean;
  /** Quality for companion downloads (HLS/DASH and files the browser could not fetch). */
  preset: Preset;
  /** Save subtitle tracks of streams as .srt next to the video, when the stream has any. */
  subtitles: boolean;
  /** Local list of finished downloads; never leaves the browser. */
  keepHistory: boolean;
}

export const PRESETS = ['best', 'max1080p', 'audioMp3'] as const;
export type Preset = (typeof PRESETS)[number];

export const DEFAULT_SETTINGS: Readonly<Settings> = { folder: 'Media Downloader', askWhereToSave: false, preset: 'best', subtitles: true, keepHistory: true };
const STORAGE_KEY = 'settings';

export function normalizeSettings(raw: unknown): Settings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    folder: typeof input.folder === 'string' ? sanitizeFolder(input.folder) : DEFAULT_SETTINGS.folder,
    askWhereToSave: typeof input.askWhereToSave === 'boolean' ? input.askWhereToSave : DEFAULT_SETTINGS.askWhereToSave,
    preset: (PRESETS as readonly unknown[]).includes(input.preset) ? (input.preset as Preset) : DEFAULT_SETTINGS.preset,
    subtitles: typeof input.subtitles === 'boolean' ? input.subtitles : DEFAULT_SETTINGS.subtitles,
    keepHistory: typeof input.keepHistory === 'boolean' ? input.keepHistory : DEFAULT_SETTINGS.keepHistory,
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
