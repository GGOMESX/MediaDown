import { describe, it, expect } from 'vitest';
import { qualityOptions, liveQualityOptions, variantForChoice, defaultOption, presetToChoice, parseQualityChoice } from './quality';

describe('qualityOptions', () => {
  it('offers best, the lower heights and audio', () => {
    expect(qualityOptions([1080, 720, 360]).map(o => o.value)).toEqual(['best', 'h720', 'h360', 'audioMp3']);
  });

  it('works when the stream does not list heights', () => {
    expect(qualityOptions([]).map(o => o.value)).toEqual(['best', 'audioMp3']);
  });

  it('ignores implausible heights', () => {
    expect(qualityOptions([1080, 100]).map(o => o.value)).toEqual(['best', 'audioMp3']);
  });
});

describe('defaultOption', () => {
  const heights = [2160, 1080, 720];

  it('maps presets to the stream options', () => {
    expect(defaultOption(heights, 'best').value).toBe('best');
    expect(defaultOption(heights, 'audioMp3').value).toBe('audioMp3');
    expect(defaultOption(heights, 'max1080p').value).toBe('h1080');
  });

  it('picks the highest option under the limit when the exact height is missing', () => {
    expect(defaultOption([2160, 900, 480], 'max1080p').value).toBe('h900');
  });

  it('uses best when the whole stream is within the limit or its size is unknown', () => {
    expect(defaultOption([720, 480], 'max1080p').value).toBe('best');
    expect(defaultOption([], 'max1080p').value).toBe('best');
  });
});

describe('presetToChoice / parseQualityChoice', () => {
  it('maps presets', () => {
    expect(presetToChoice('max1080p')).toEqual({ mode: 'maxHeight', height: 1080 });
  });

  it('validates choices from messages', () => {
    expect(parseQualityChoice({ mode: 'maxHeight', height: 720 })).toEqual({ mode: 'maxHeight', height: 720 });
    expect(parseQualityChoice({ mode: 'maxHeight', height: 1 })).toBeNull();
    expect(parseQualityChoice({ mode: 'maxHeight', height: '720' })).toBeNull();
    expect(parseQualityChoice({ mode: 'exec' })).toBeNull();
  });
});

describe('live recording quality', () => {
  it('offers no audio-only option', () => {
    expect(liveQualityOptions([1080, 720]).map(o => o.value)).toEqual(['best', 'h720']);
  });

  it('picks the tallest variant within the limit, by playlist index', () => {
    const variants = [360, 1080, 720, null];
    expect(variantForChoice(variants, { mode: 'maxHeight', height: 720 })).toBe(2);
    expect(variantForChoice(variants, { mode: 'maxHeight', height: 900 })).toBe(2);
    expect(variantForChoice(variants, { mode: 'maxHeight', height: 144 })).toBe(0);
  });

  it('lets ffmpeg choose for "best" or when heights are unknown', () => {
    expect(variantForChoice([360, 1080], { mode: 'best' })).toBeUndefined();
    expect(variantForChoice([null, null], { mode: 'maxHeight', height: 720 })).toBeUndefined();
  });
});
