import { describe, it, expect } from 'vitest';
import { vttToSrt } from './subtitles';

describe('vttToSrt', () => {
  it('converts timing, numbers cues and drops the header', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nOlá, mundo\n\n00:00:04.000 --> 00:00:05.000\nSegunda linha\ncontinua aqui\n';
    expect(vttToSrt(vtt)).toBe(
      '1\n00:00:01,000 --> 00:00:03,500\nOlá, mundo\n\n2\n00:00:04,000 --> 00:00:05,000\nSegunda linha\ncontinua aqui\n',
    );
  });

  it('accepts short timestamps without hours and cue identifiers', () => {
    const vtt = 'WEBVTT - Curso\n\nintro\n01:02.5 --> 01:04.25 align:start position:10%\nTexto\n';
    expect(vttToSrt(vtt)).toBe('1\n00:01:02,500 --> 00:01:04,250\nTexto\n');
  });

  it('removes styling tags and decodes entities', () => {
    const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<v Ana><i>Rust</i> &amp; <c.yellow>segurança</c> &lt;3</v>\n';
    expect(vttToSrt(vtt)).toContain('Rust & segurança <3');
  });

  it('skips NOTE/STYLE blocks and empty cues, handles CRLF and BOM', () => {
    const vtt = '﻿WEBVTT\r\n\r\nNOTE isto é um comentário\r\n\r\nSTYLE\r\n::cue { color: red }\r\n\r\n00:00:00.000 --> 00:00:01.000\r\n\r\n00:00:02.000 --> 00:00:03.000\r\nFica\r\n';
    expect(vttToSrt(vtt)).toBe('1\n00:00:02,000 --> 00:00:03,000\nFica\n');
  });

  it('returns an empty string when there are no cues', () => {
    expect(vttToSrt('WEBVTT\n\nNOTE vazio\n')).toBe('');
  });
});
