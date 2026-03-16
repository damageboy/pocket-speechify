// src/word-timing-estimator.js

/**
 * Estimates word timing from audio chunk positions using proportional
 * character length. Pluggable — will be replaced when pocket-tts adds
 * native word-level timestamps.
 *
 * @param {Array<{text: string}>} words - Word objects with .text property
 * @param {number} estimatedTotalSec - Estimated total audio duration for this sentence
 * @returns {{ feedAudioDuration, finalize }}
 */
export function createWordTimingEstimator(words, estimatedTotalSec) {
  if (!words || words.length === 0) {
    return { feedAudioDuration: () => [], finalize: () => [] };
  }

  const totalChars = words.reduce((sum, w) => sum + w.text.length, 0);

  // Build start-time thresholds: word[i] starts at thresholds[i] seconds
  const thresholds = [];
  let cumChars = 0;
  for (const w of words) {
    thresholds.push((cumChars / totalChars) * estimatedTotalSec);
    cumChars += w.text.length;
  }

  let nextWordIdx = 0;

  return {
    /**
     * Feed cumulative scheduled audio duration (seconds).
     * Returns events for words whose start threshold has been crossed.
     */
    feedAudioDuration(cumulativeSec) {
      const events = [];
      while (nextWordIdx < words.length && cumulativeSec >= thresholds[nextWordIdx]) {
        events.push({
          wordIndex: nextWordIdx,
          word: words[nextWordIdx].text,
          estimatedTimeSec: thresholds[nextWordIdx],
        });
        nextWordIdx++;
      }
      return events;
    },

    /**
     * Emit any remaining words that haven't been emitted yet.
     * Called when the sentence generation completes (actual duration known).
     */
    finalize() {
      const events = [];
      while (nextWordIdx < words.length) {
        events.push({
          wordIndex: nextWordIdx,
          word: words[nextWordIdx].text,
          estimatedTimeSec: thresholds[nextWordIdx],
        });
        nextWordIdx++;
      }
      return events;
    },
  };
}
