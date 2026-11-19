import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, normalizeSettings } from './settings';

describe('normalizeSettings', () => {
  it('fills missing fields with defaults', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('sanitizes the folder and rejects wrong types', () => {
    expect(normalizeSettings({ folder: '../Cursos', askWhereToSave: 'yes', preset: '8k' })).toEqual({ folder: 'Cursos', askWhereToSave: false, preset: 'best' });
  });

  it('ignores garbage input', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('settings persistence', () => {
  beforeEach(() => fakeBrowser.reset());

  it('returns defaults on first run', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips saved settings in normalized form', async () => {
    await saveSettings({ folder: 'Vídeos//Aulas', askWhereToSave: true, preset: 'audioMp3' });
    expect(await loadSettings()).toEqual({ folder: 'Vídeos/Aulas', askWhereToSave: true, preset: 'audioMp3' });
  });
});
