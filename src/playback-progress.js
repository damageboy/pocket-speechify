// Playback progress is derived from the reading position, not from audio
// clocks: words read vs. words in scope, converted to time with a
// seconds-per-word rate (measured from generated audio at 1x) and the current
// speed. Pause, seek and speed changes are therefore always consistent.

// Typical pocket-tts pace at 1x (~150 wpm), used until playback is measured.
export const DEFAULT_SEC_PER_WORD = 0.4;
// Words of measured audio required before trusting the measured rate.
export const MIN_MEASURED_WORDS = 30;

export const EMPTY_PROGRESS = Object.freeze({ totalSec: 0, remainingSec: 0, percent: 0 });

/**
 * @param {object} args
 * @param {{ words: unknown[] }[]} args.paragraphs
 * @param {number[]} args.scope - paragraph indices playback covers, in order
 * @param {{ paragraphIndex: number, wordIndex: number } | null} args.position
 *   next word to be read; null when idle
 * @param {number} args.secPerWord - at 1x
 * @param {number} args.speed
 */
export function computeProgress({ paragraphs, scope, position, secPerWord, speed }) {
	let totalWords = 0;
	let readWords = 0;
	let reached = false;
	for (const index of scope) {
		const count = paragraphs[index]?.words.length ?? 0;
		totalWords += count;
		if (!position || reached) continue;
		if (index === position.paragraphIndex) {
			readWords += Math.min(position.wordIndex, count);
			reached = true;
		} else {
			readWords += count;
		}
	}
	if (position && !reached) readWords = 0; // position outside scope
	if (totalWords === 0) return EMPTY_PROGRESS;
	const secPerWordAtSpeed = secPerWord / speed;
	return {
		totalSec: totalWords * secPerWordAtSpeed,
		remainingSec: (totalWords - readWords) * secPerWordAtSpeed,
		percent: (readWords / totalWords) * 100,
	};
}

/** Accumulates measured audio per paragraph into a seconds-per-word rate. */
export function createRateMeter() {
	let sourceSec = 0;
	let words = 0;
	return {
		add(measuredSec, measuredWords) {
			if (!(measuredSec > 0) || !(measuredWords > 0)) return;
			sourceSec += measuredSec;
			words += measuredWords;
		},
		reset() {
			sourceSec = 0;
			words = 0;
		},
		secPerWord() {
			return words >= MIN_MEASURED_WORDS ? sourceSec / words : DEFAULT_SEC_PER_WORD;
		},
	};
}
