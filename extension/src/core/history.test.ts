import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { addEntry, readHistory, clearHistory, rememberPending, completePending, dropPending, MAX_HISTORY, type HistoryEntry, type PendingEntry } from './history';
import { saveSettings, DEFAULT_SETTINGS } from './settings';

const pending = (id: string): PendingEntry => ({ id, pageTitle: 'Aula 1', pageHost: 'curso.example.com', via: 'companion', kind: 'hls' });
const entry = (id: string): HistoryEntry => ({ ...pending(id), fileName: `${id}.mp4`, completedAt: 1 });

describe('addEntry', () => {
  it('puts the newest first and replaces duplicates', () => {
    const list = addEntry(addEntry([entry('a')], entry('b')), { ...entry('a'), fileName: 'novo.mp4' });
    expect(list.map(e => e.fileName)).toEqual(['novo.mp4', 'b.mp4']);
  });

  it('keeps at most MAX_HISTORY entries', () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < MAX_HISTORY + 20; i++) list = addEntry(list, entry(String(i)));
    expect(list).toHaveLength(MAX_HISTORY);
    expect(list[0]?.id).toBe(String(MAX_HISTORY + 19));
  });
});

describe('pending downloads', () => {
  beforeEach(() => fakeBrowser.reset());

  it('records a finished download with what was captured at start', async () => {
    await rememberPending(pending('jt1-a'));
    await completePending('jt1-a', { fileName: 'Aula 1.mp4', sizeBytes: 900 }, 1234);
    expect(await readHistory()).toEqual([{ ...pending('jt1-a'), fileName: 'Aula 1.mp4', sizeBytes: 900, completedAt: 1234 }]);
  });

  it('ignores completions it never saw start', async () => {
    await completePending('unknown', { fileName: 'x.mp4' });
    expect(await readHistory()).toEqual([]);
  });

  it('forgets failed downloads', async () => {
    await rememberPending(pending('d9'));
    await dropPending('d9');
    await completePending('d9', { fileName: 'x.mp4' });
    expect(await readHistory()).toEqual([]);
  });

  it('records nothing when history is turned off', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, keepHistory: false });
    await rememberPending(pending('d1'));
    await completePending('d1', { fileName: 'x.mp4' });
    expect(await readHistory()).toEqual([]);
  });

  it('handles concurrent completions without losing entries', async () => {
    await Promise.all(['a', 'b', 'c'].map(id => rememberPending(pending(id))));
    await Promise.all(['a', 'b', 'c'].map(id => completePending(id, { fileName: `${id}.mp4` })));
    expect((await readHistory()).map(e => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('can be cleared', async () => {
    await rememberPending(pending('a'));
    await completePending('a', { fileName: 'a.mp4' });
    await clearHistory();
    expect(await readHistory()).toEqual([]);
  });
});
