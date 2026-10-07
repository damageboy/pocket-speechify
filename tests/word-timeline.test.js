import { describe, expect, it } from 'vitest';
import { createWordTimeline } from '../src/word-timeline.js';
import { preprocessText } from '../src/text-rules.js';

const start = (word, word_index, start_time) => ({ kind: 'word_start', word, word_index, start_time });
const end = (word, word_index, start_time, end_time) => ({ kind: 'word_end', word, word_index, start_time, end_time });

describe('timestamp playback timeline', () => {
  it('maps processed words and reordered captures back to the original page after a seek', () => {
    const text = 'Dr. Ada [12] met Bo.';
    const processed = preprocessText(text, [
      { name: 'Title', pattern: 'Dr\\.', flags: 'g', replacement: 'Medical doctor', enabled: true },
      { name: 'Citations', pattern: '\\[12\\] ', flags: 'g', replacement: '', enabled: true },
      { name: 'Names', pattern: '(Ada) (met) (Bo)', flags: 'g', replacement: '$3 $2 $1', enabled: true },
    ]);
    const timeline = createWordTimeline(text, 5, { processed });
    timeline.addAudio(6, 0, 6);
    timeline.addEvents([
      start('Medical', 0, 0), start('doctor', 1, 1), start('Bo', 2, 2),
      start('met', 3, 3), start('Ada', 4, 4),
    ]);
    expect([0, 1, 2, 3, 4].map(t => timeline.wordAt(t)?.wordIndex)).toEqual([5, 5, 9, 8, 6]);
  });

  it('does not highlight zero-width inserted words or engine spelling mismatches', () => {
    const text = 'Hello.';
    const processed = preprocessText(text, [
      { name: 'Prefix', pattern: '^', flags: 'g', replacement: 'Note: ', enabled: true },
    ]);
    const timeline = createWordTimeline(text, 0, { processed });
    timeline.addAudio(3, 0, 3);
    timeline.addEvents([start('Note', 0, 0), start('wrong', 1, 1)]);
    expect(timeline.wordAt(0)).toBeNull();
    expect(timeline.wordAt(1)).toBeNull();
  });

  it('ignores upstream pause markers while retaining original page word indices', () => {
    const timeline = createWordTimeline('Hello [pause:500ms] world.');
    timeline.addAudio(2, 0, 2);
    timeline.addEvents([end('Hello', 0, 0, 0.5), start('world', 1, 1)]);
    expect(timeline.wordAt(1.2)).toEqual({ wordIndex: 2, word: 'world' });
  });

  it('compensates both stretcher latencies across a speed change and the flushed tail', () => {
    const timeline = createWordTimeline('First last.', 0, { inputLatency: 0.06, outputLatency: 0.06 });
    timeline.addAudio(1, 10, 11);
    timeline.addAudio(1, 11, 11.5);
    timeline.addAudio(0.06, 11.5, 11.53); // input-latency padding at 2x
    timeline.addAudio(0, 11.53, 11.59); // output-latency flush
    timeline.addEvents([start('First', 0, 0), end('First', 0, 0, 1), start('last', 1, 1), end('last', 1, 1, 2)]);
    expect(timeline.wordAt(10.11)).toBeNull();
    expect(timeline.wordAt(10.13)?.word).toBe('First');
    expect(timeline.wordAt(11.08)?.word).toBe('First');
    expect(timeline.wordAt(11.10)?.word).toBe('last');
    expect(timeline.wordAt(11.58)?.word).toBe('last');
    expect(timeline.wordAt(11.59)).toBeNull();
  });

  it('uses native boundaries, including a late event-only word end', () => {
    const timeline = createWordTimeline('Tiny elephant.');
    timeline.addAudio(2, 10, 12);
    timeline.addEvents([start('Tiny', 0, 0.32), end('Tiny', 0, 0.32, 0.48), start('elephant', 1, 0.8)]);
    expect(timeline.wordAt(10.31)).toBeNull();
    expect(timeline.wordAt(10.33)).toEqual({ wordIndex: 0, word: 'Tiny' });
    expect(timeline.wordAt(10.49)).toBeNull();
    expect(timeline.wordAt(11.6)).toEqual({ wordIndex: 1, word: 'elephant' });
    timeline.addEvents([end('elephant', 1, 0.8, 1.44)]);
    expect(timeline.wordAt(11.6)).toBeNull();
  });

  it('maps each stretched chunk separately and never advances across an underrun', () => {
    const timeline = createWordTimeline('First second third.');
    timeline.addEvents([start('First', 0, 0), end('First', 0, 0, 0.8), start('second', 1, 1), end('second', 1, 1, 1.5), start('third', 2, 1.5)]);
    timeline.addAudio(1, 20, 21); // 1x
    timeline.addAudio(1, 25, 25.5); // underrun, then 2x
    expect(timeline.wordAt(20.5)?.word).toBe('First');
    expect(timeline.wordAt(23)).toBeNull();
    expect(timeline.wordAt(25.2)?.word).toBe('second');
    // A frozen AudioContext clock during pause must retain the same word.
    expect(timeline.wordAt(25.2)?.word).toBe('second');
    expect(timeline.wordAt(25.3)?.word).toBe('third');
    expect(timeline.wordAt(25.5)).toBeNull();
  });

  it('maps lexical words to original whitespace words without index clamping', () => {
    const timeline = createWordTimeline('“café”—yes 3.14 l’été re-entry', 7);
    timeline.addAudio(6, 0, 6);
    timeline.addEvents([
      start('café', 0, 0), start('yes', 1, 1), start('3', 2, 2),
      start('14', 3, 3), start('l’été', 4, 4), start('re-entry', 5, 5),
    ]);
    expect([0, 1, 2, 3, 4, 5].map(t => timeline.wordAt(t)?.wordIndex)).toEqual([7, 7, 8, 8, 9, 10]);
  });

  it('does not guess for mismatched words, missing indices, or unspoken words', () => {
    const timeline = createWordTimeline('One skipped three.');
    timeline.addAudio(3, 0, 3);
    timeline.addEvents([end('One', 0, 0, 0.5), start('wrong', 1, 0.5), start('three', 2, 2)]);
    expect(timeline.wordAt(1)).toBeNull();
    expect(timeline.wordAt(2.5)).toEqual({ wordIndex: 2, word: 'three' });
  });
});
