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

		expect(plan.ttsParagraphs).toEqual(paragraphs);
		expect(plan.ttsStartParagraph).toBe(1);
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
		expect(toGlobalParagraphIndex(plan, 0)).toBe(1);
		expect(canMoveToParagraph(plan, 1)).toBe(true);
		expect(canMoveToParagraph(plan, 2)).toBe(false);
	});

	it("follows the playing paragraph by identity when the live list is rebuilt", () => {
		const live = [
			{ twitterIdentity: "status:a", text: "A." },
			{ twitterIdentity: "status:b", text: "B." },
		];
		const plan = createPlaybackPlan({
			paragraphs: live,
			fromParagraph: 1,
			playbackMode: "single",
		});

		// Timeline virtualizes: a new tweet is prepended and objects are rebuilt.
		live.splice(
			0,
			live.length,
			{ twitterIdentity: "status:new", text: "New." },
			{ twitterIdentity: "status:a", text: "A." },
			{ twitterIdentity: "status:b", text: "B." },
		);
		expect(toGlobalParagraphIndex(plan, 0)).toBe(2);
		expect(canMoveToParagraph(plan, 2)).toBe(true);

		live.splice(0, live.length, { twitterIdentity: "status:new", text: "New." });
		expect(toGlobalParagraphIndex(plan, 0)).toBeNull();
	});

	it("snapshots continuous playback and follows its paragraphs through insertions", () => {
		const live = [{ element: {}, text: "First." }, { element: {}, text: "Second." }];
		const plan = createPlaybackPlan({ paragraphs: live, fromParagraph: 1 });
		live.unshift({ element: {}, text: "Inserted." });
		expect(plan.ttsParagraphs.map(p => p.text)).toEqual(["First.", "Second."]);
		expect(toGlobalParagraphIndex(plan, 1)).toBe(2);
		live.splice(2, 1);
		expect(toGlobalParagraphIndex(plan, 1)).toBeNull();
	});

	it("does not map spoken text onto an edited tweet with the same identity", () => {
		const live = [{ twitterIdentity: "status:a", text: "Original words." }];
		const plan = createPlaybackPlan({ paragraphs: live, playbackMode: "single" });
		live[0] = { twitterIdentity: "status:a", text: "Changed words." };
		expect(toGlobalParagraphIndex(plan, 0)).toBeNull();
	});

	it("distinguishes parent text fragments that share an element and spelling", () => {
		const element = {};
		const live = [
			{ element, text: "Repeat.", startOffset: 0 },
			{ element: {}, text: "Nested." },
			{ element, text: "Repeat.", startOffset: 8 },
		];
		const plan = createPlaybackPlan({ paragraphs: live, fromParagraph: 2 });
		live.unshift({ element: {}, text: "Inserted." });
		expect(toGlobalParagraphIndex(plan, 2)).toBe(3);
	});
});
