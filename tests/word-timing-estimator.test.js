import { describe, it, expect } from 'vitest';
import { createWordTimingEstimator } from '../src/word-timing-estimator.js';

describe('createWordTimingEstimator', () => {
  it('returns stub for empty word list', () => {
    const est = createWordTimingEstimator([], 10);
    expect(est.feedAudioDuration(5)).toEqual([]);
    expect(est.finalize()).toEqual([]);
  });

  it('returns stub for null word list', () => {
    const est = createWordTimingEstimator(null, 10);
    expect(est.feedAudioDuration(5)).toEqual([]);
    expect(est.finalize()).toEqual([]);
  });

  it('emits first word at time 0 on first feed', () => {
    const words = [{ text: 'hello' }, { text: 'world' }];
    const est = createWordTimingEstimator(words, 10);
    // First word threshold is 0, so it fires immediately
    const events = est.feedAudioDuration(0);
    expect(events).toHaveLength(1);
    expect(events[0].wordIndex).toBe(0);
    expect(events[0].word).toBe('hello');
    expect(events[0].estimatedTimeSec).toBe(0);
  });

  it('emits word events as cumulative audio crosses thresholds', () => {
    const words = [{ text: 'hello' }, { text: 'world' }];
    // totalChars = 10, estimatedTotalSec = 10
    // thresholds: hello -> 0, world -> 5
    const est = createWordTimingEstimator(words, 10);

    const events1 = est.feedAudioDuration(0);
    expect(events1).toHaveLength(1);
    expect(events1[0].word).toBe('hello');

    const events2 = est.feedAudioDuration(4.9);
    expect(events2).toHaveLength(0); // 'world' threshold is 5

    const events3 = est.feedAudioDuration(5.0);
    expect(events3).toHaveLength(1);
    expect(events3[0].word).toBe('world');
    expect(events3[0].wordIndex).toBe(1);
  });

  it('does not re-emit already emitted words on subsequent feeds', () => {
    const words = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
    const est = createWordTimingEstimator(words, 9);

    est.feedAudioDuration(0);  // emits 'a'
    est.feedAudioDuration(3);  // emits 'b'
    const events = est.feedAudioDuration(6); // emits 'c'
    expect(events).toHaveLength(1);
    expect(events[0].word).toBe('c');
  });

  it('emits multiple words when a large time jump crosses several thresholds', () => {
    const words = [{ text: 'one' }, { text: 'two' }, { text: 'three' }];
    // totalChars = 11, estimatedTotalSec = 11
    // thresholds approx: one->0, two->3, three->6
    const est = createWordTimingEstimator(words, 11);

    const events = est.feedAudioDuration(11);
    expect(events).toHaveLength(3);
    expect(events.map(e => e.word)).toEqual(['one', 'two', 'three']);
  });

  it('finalize emits remaining unemitted words', () => {
    const words = [{ text: 'alpha' }, { text: 'beta' }, { text: 'gamma' }];
    const est = createWordTimingEstimator(words, 10);

    est.feedAudioDuration(0); // emits 'alpha'
    const remaining = est.finalize();
    expect(remaining).toHaveLength(2);
    expect(remaining[0].word).toBe('beta');
    expect(remaining[1].word).toBe('gamma');
  });

  it('finalize returns empty array if all words already emitted', () => {
    const words = [{ text: 'only' }];
    const est = createWordTimingEstimator(words, 5);

    est.feedAudioDuration(10);
    expect(est.finalize()).toEqual([]);
  });

  it('longer words get proportionally later thresholds', () => {
    // 'short' = 5 chars, 'muchlonger' = 10 chars, total = 15 chars, totalSec = 15
    // thresholds: short -> 0, muchlonger -> 5
    const words = [{ text: 'short' }, { text: 'muchlonger' }];
    const est = createWordTimingEstimator(words, 15);

    const events1 = est.feedAudioDuration(0);
    expect(events1[0].word).toBe('short');
    expect(events1[0].estimatedTimeSec).toBe(0);

    const events2 = est.feedAudioDuration(5);
    expect(events2[0].word).toBe('muchlonger');
    expect(events2[0].estimatedTimeSec).toBeCloseTo(5, 5);
  });

  it('single word has threshold at 0', () => {
    const words = [{ text: 'hello' }];
    const est = createWordTimingEstimator(words, 5);
    const events = est.feedAudioDuration(0);
    expect(events).toHaveLength(1);
    expect(events[0].estimatedTimeSec).toBe(0);
  });

  it('events have correct shape with wordIndex, word, estimatedTimeSec', () => {
    const words = [{ text: 'test' }];
    const est = createWordTimingEstimator(words, 1);
    const events = est.feedAudioDuration(0);
    expect(events[0]).toHaveProperty('wordIndex');
    expect(events[0]).toHaveProperty('word');
    expect(events[0]).toHaveProperty('estimatedTimeSec');
  });
});
