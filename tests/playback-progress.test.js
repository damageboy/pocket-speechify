import { describe, expect, it } from "vitest";
import {
	DEFAULT_SEC_PER_WORD,
	EMPTY_PROGRESS,
	computeProgress,
	createRateMeter,
} from "../src/playback-progress.js";

const para = (count) => ({ words: Array.from({ length: count }, () => ({})) });
const paragraphs = [para(10), para(20), para(10)];
const all = [0, 1, 2];

describe("computeProgress", () => {
	it("reports the full duration with no position", () => {
		expect(
			computeProgress({ paragraphs, scope: all, position: null, secPerWord: 0.5, speed: 1 }),
		).toEqual({ totalSec: 20, remainingSec: 20, percent: 0 });
	});

	it("counts paragraphs before the position as read, including skipped ones", () => {
		const progress = computeProgress({
			paragraphs,
			scope: all,
			position: { paragraphIndex: 1, wordIndex: 10 },
			secPerWord: 0.5,
			speed: 1,
		});
		expect(progress).toEqual({ totalSec: 20, remainingSec: 10, percent: 50 });
	});

	it("divides time, not progress, by the current speed", () => {
		const progress = computeProgress({
			paragraphs,
			scope: all,
			position: { paragraphIndex: 1, wordIndex: 10 },
			secPerWord: 0.5,
			speed: 2,
		});
		expect(progress).toEqual({ totalSec: 10, remainingSec: 5, percent: 50 });
	});

	it("limits single-paragraph playback to its scope", () => {
		const progress = computeProgress({
			paragraphs,
			scope: [1],
			position: { paragraphIndex: 1, wordIndex: 5 },
			secPerWord: 1,
			speed: 1,
		});
		expect(progress).toEqual({ totalSec: 20, remainingSec: 15, percent: 25 });
	});

	it("handles empty scopes and positions outside the scope", () => {
		expect(
			computeProgress({ paragraphs, scope: [], position: null, secPerWord: 1, speed: 1 }),
		).toBe(EMPTY_PROGRESS);
		expect(
			computeProgress({
				paragraphs,
				scope: [1],
				position: { paragraphIndex: null, wordIndex: 3 },
				secPerWord: 1,
				speed: 1,
			}).percent,
		).toBe(0);
	});
});

describe("createRateMeter", () => {
	it("uses the default until enough words are measured, then the measured rate", () => {
		const meter = createRateMeter();
		meter.add(6, 10);
		expect(meter.secPerWord()).toBe(DEFAULT_SEC_PER_WORD);
		meter.add(9, 20);
		expect(meter.secPerWord()).toBeCloseTo(0.5);
		meter.add(0, 5); // ignored: no audio
		expect(meter.secPerWord()).toBeCloseTo(0.5);
		meter.reset();
		expect(meter.secPerWord()).toBe(DEFAULT_SEC_PER_WORD);
	});
});
