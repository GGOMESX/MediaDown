import { describe, it, expect } from 'vitest';
import { sanitizeFileName, sanitizeFolder, buildDownloadPath, chooseBaseName, toAsciiPath } from './file-name';

describe('sanitizeFileName', () => {
  it('replaces characters forbidden on Windows, macOS and Linux', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j.mp4')).toBe('a_b_c_d_e_f_g_h_i_j.mp4');
  });

  it('removes control characters', () => {
    expect(sanitizeFileName('aula\u0000\u001f1.mp4')).toBe('aula1.mp4');
  });

  it('blocks path traversal', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFileName('..')).toBe('video');
  });

  it('trims leading/trailing dots and spaces (invalid on Windows)', () => {
    expect(sanitizeFileName('  .oculto.mp4. ')).toBe('oculto.mp4');
  });

  it('escapes Windows reserved device names', () => {
    expect(sanitizeFileName('CON.mp4')).toBe('_CON.mp4');
    expect(sanitizeFileName('lpt1')).toBe('_lpt1');
  });

  it('limits length while preserving the extension', () => {
    const result = sanitizeFileName(`${'a'.repeat(300)}.webm`);
    expect(result.length).toBe(150);
    expect(result.endsWith('.webm')).toBe(true);
  });

  it('falls back to a default name when nothing is left', () => {
    expect(sanitizeFileName('   ')).toBe('video');
  });
});

describe('sanitizeFolder', () => {
  it('keeps nested folders but sanitizes each segment', () => {
    expect(sanitizeFolder('Vídeos/Cursos: 2026')).toBe('Vídeos/Cursos_ 2026');
  });

  it('drops traversal and empty segments', () => {
    expect(sanitizeFolder('../a//./b/..')).toBe('a/b');
  });

  it('accepts an empty folder (save directly in Downloads)', () => {
    expect(sanitizeFolder('')).toBe('');
  });
});

describe('chooseBaseName', () => {
  it('uses the file name from the URL', () => {
    expect(chooseBaseName('https://c.example.com/v/minha%20aula.mp4', 'video/mp4', 'Página')).toBe('minha aula.mp4');
  });

  it('prefers the page title when the URL name looks machine-generated', () => {
    expect(chooseBaseName('https://c.example.com/3f9a8c2e1b7d4a6f9e0c.mp4', 'video/mp4', 'Aula 1 — Introdução')).toBe('Aula 1 — Introdução.mp4');
    expect(chooseBaseName('https://c.example.com/v/123456789.webm', 'video/webm', 'Clipe')).toBe('Clipe.webm');
  });

  it('adds an extension from the content-type when the URL has none', () => {
    expect(chooseBaseName('https://c.example.com/stream/video-final', 'video/webm', '')).toBe('video-final.webm');
  });

  it('defaults to mp4 when neither URL nor content-type say otherwise', () => {
    expect(chooseBaseName('https://c.example.com/play', '', '')).toBe('play.mp4');
  });
});

describe('buildDownloadPath', () => {
  it('joins folder and file name', () => {
    expect(buildDownloadPath('Media Downloader', 'aula.mp4')).toBe('Media Downloader/aula.mp4');
  });

  it('returns only the file name when there is no folder', () => {
    expect(buildDownloadPath('', 'aula.mp4')).toBe('aula.mp4');
  });
});

describe('toAsciiPath', () => {
  it('strips accents and keeps the folder structure', () => {
    expect(toAsciiPath('Cursos/Rust avançado/Introdução.mp4')).toBe('Cursos/Rust avancado/Introducao.mp4');
  });

  it('replaces characters without an ASCII equivalent', () => {
    expect(toAsciiPath('日本語 — aula.mp4')).toBe('___ _ aula.mp4');
  });
});
