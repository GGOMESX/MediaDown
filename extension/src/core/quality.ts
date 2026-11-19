import type { Preset } from './settings';

export type QualityChoice = { mode: 'best' } | { mode: 'maxHeight'; height: number } | { mode: 'audioMp3' };

export interface QualityOption {
  value: string;
  choice: QualityChoice;
}

export const MIN_HEIGHT = 144;
export const MAX_HEIGHT = 4320;

export function presetToChoice(preset: Preset): QualityChoice {
  if (preset === 'max1080p') return { mode: 'maxHeight', height: 1080 };
  if (preset === 'audioMp3') return { mode: 'audioMp3' };
  return { mode: 'best' };
}

export function encodeChoice(choice: QualityChoice): string {
  return choice.mode === 'maxHeight' ? `h${choice.height}` : choice.mode;
}

/** Options for a stream's quality picker: best, each offered height below the top one, audio only. */
export function qualityOptions(heights: readonly number[]): QualityOption[] {
  const below = [...heights].sort((a, b) => b - a).slice(1).filter(h => h >= MIN_HEIGHT && h <= MAX_HEIGHT);
  const choices: QualityChoice[] = [{ mode: 'best' }, ...below.map(height => ({ mode: 'maxHeight' as const, height })), { mode: 'audioMp3' }];
  return choices.map(choice => ({ value: encodeChoice(choice), choice }));
}

/** The option matching the user's default preset, approximated to what the stream offers. */
export function defaultOption(heights: readonly number[], preset: Preset): QualityOption {
  const options = qualityOptions(heights);
  const wanted = presetToChoice(preset);
  if (wanted.mode !== 'maxHeight') return options.find(o => o.choice.mode === wanted.mode) ?? options[0]!;
  // "Up to 1080p" on a stream topping at 720p (or of unknown size) is simply its best.
  const top = Math.max(0, ...heights);
  if (top <= wanted.height) return options[0]!;
  return options.find(o => o.choice.mode === 'maxHeight' && o.choice.height <= wanted.height) ?? options[0]!;
}

export function parseQualityChoice(raw: unknown): QualityChoice | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { mode, height } = raw as Record<string, unknown>;
  if (mode === 'best' || mode === 'audioMp3') return { mode };
  if (mode === 'maxHeight' && typeof height === 'number' && Number.isInteger(height) && height >= MIN_HEIGHT && height <= MAX_HEIGHT) {
    return { mode, height };
  }
  return null;
}
