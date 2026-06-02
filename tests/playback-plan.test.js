import { describe, expect, it } from "vitest";
import {
	canMoveToParagraph,
	createPlaybackPlan,
	toGlobalParagraphIndex,
} from "../src/playback-plan.js";

const paragraphs = [
	{ text: "First tweet." },
	{ text: "Second tweet." },
	{ text: "Third tweet." },
];

describe("createPlaybackPlan", () => {
	it("keeps generic playback continuous from the requested paragraph", () => {
		const plan = createPlaybackPlan({
			paragraphs,
			fromParagraph: 1,
			playbackMode: "continuous",
		});

		expect(plan.ttsParagraphs).toBe(paragraphs);
		expect(plan.ttsStartParagraph).toBe(1);
		expect(plan.paragraphIndexOffset).toBe(0);
		expect(toGlobalParagraphIndex(plan, 2)).toBe(2);
	});

	it("scopes single playback to the selected paragraph and maps indexes back to global paragraphs", () => {
		const plan = createPlaybackPlan({
			paragraphs,
			fromParagraph: 1,
			playbackMode: "single",
		});

		expect(plan.ttsParagraphs).toEqual([paragraphs[1]]);
		expect(plan.ttsStartParagraph).toBe(0);
		expect(plan.paragraphIndexOffset).toBe(1);
		expect(toGlobalParagraphIndex(plan, 0)).toBe(1);
		expect(canMoveToParagraph(plan, 1)).toBe(true);
		expect(canMoveToParagraph(plan, 2)).toBe(false);
	});
});
