const TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
const TAGS = /<\/?(?:c|v|b|i|u|ruby|rt|lang)(?:[.\s][^>]*)?>|<\d{2}:\d{2}[^>]*>/g;

/**
 * Converts WebVTT to SubRip. Players everywhere understand .srt; .vtt support is spotty
 * outside browsers. Styling and positioning cues are dropped, the text and timing kept.
 */
export function vttToSrt(vtt: string): string {
  const blocks = vtt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues: string[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex(line => TIMING.test(line));
    if (timingIndex === -1) continue; // header, NOTE, STYLE or REGION block

    const [, start, end] = lines[timingIndex]!.match(TIMING)!;
    const text = lines
      .slice(timingIndex + 1)
      .map(line => decodeEntities(line.replace(TAGS, '')).trimEnd())
      .filter(line => line.trim() !== '');
    if (text.length === 0) continue;

    cues.push(`${cues.length + 1}\n${toSrtTime(start!)} --> ${toSrtTime(end!)}\n${text.join('\n')}`);
  }
  return cues.length > 0 ? `${cues.join('\n\n')}\n` : '';
}

function toSrtTime(vttTime: string): string {
  const [clock, fraction = '0'] = vttTime.replace(',', '.').split('.');
  const parts = clock!.split(':').map(Number);
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, ...parts];
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(hours!)}:${pad(minutes!)}:${pad(seconds!)},${fraction.padEnd(3, '0').slice(0, 3)}`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lrm;|&rlm;/g, '')
    .replace(/&amp;/g, '&');
}
