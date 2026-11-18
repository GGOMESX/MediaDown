import { describe, it, expect } from 'vitest';
import { formatBytes, displayName } from './format';

describe('formatBytes', () => {
  it.each([
    [undefined, ''],
    [512, '512 B'],
    [1536, '1,5 KB'],
    [5 * 1024 * 1024, '5,0 MB'],
    [3.25 * 1024 ** 3, '3,3 GB'],
  ])('formats %s as "%s"', (bytes, expected) => {
    expect(formatBytes(bytes, 'pt-BR')).toBe(expected);
  });
});

describe('displayName', () => {
  it('uses the decoded file name from the path', () => {
    expect(displayName('https://c.example.com/videos/minha%20aula.mp4?t=1')).toBe('minha aula.mp4');
  });

  it('includes the parent folder for generic manifest names', () => {
    expect(displayName('https://c.example.com/curso/aula-01/index.m3u8')).toBe('aula-01/index.m3u8');
  });

  it('falls back to the host when the path is empty', () => {
    expect(displayName('https://c.example.com/')).toBe('c.example.com');
  });

  it('survives malformed percent-encoding', () => {
    expect(displayName('https://c.example.com/bad%E0%A4%A.mp4')).toBe('bad%E0%A4%A.mp4');
  });
});
