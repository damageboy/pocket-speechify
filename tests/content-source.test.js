import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	createContentSource,
	extractContent,
} from "../src/content-extractor.js";

function makeVisible(el) {
	Object.defineProperty(el, "offsetParent", {
		get: () => document.body,
		configurable: true,
	});
	Object.defineProperty(el, "offsetWidth", {
		get: () => 100,
		configurable: true,
	});
	Object.defineProperty(el, "offsetHeight", {
		get: () => 20,
		configurable: true,
	});
}

function appendTextElement(parent, tagName, text) {
	const element = document.createElement(tagName);
	element.textContent = text;
	parent.appendChild(element);
	makeVisible(element);
	return element;
}

function appendTweet(parent, text, attributes = {}) {
	const article = document.createElement("article");
	article.setAttribute("data-testid", "tweet");
	article.setAttribute("role", "article");
	const tweetText = document.createElement("div");
	tweetText.setAttribute("data-testid", "tweetText");
	tweetText.setAttribute("lang", attributes.lang || "en");
	if (attributes.ariaHidden) tweetText.setAttribute("aria-hidden", "true");
	tweetText.textContent = text;
	article.appendChild(tweetText);
	parent.appendChild(article);
	makeVisible(article);
	makeVisible(tweetText);
	return tweetText;
}

beforeEach(() => {
	vi.useFakeTimers();
	document.body.replaceChildren();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createContentSource", () => {
	it("uses the generic extractor on non-site pages and keeps ignoring generic div text", () => {
		appendTextElement(document.body, "div", "Just a div should not be read.");
		appendTextElement(document.body, "p", "A paragraph should be read.");

		const source = createContentSource(
			new URL("https://example.com/story"),
			document,
		);

		expect(source.site).toBe("generic");
		expect(source.getParagraphs().map((p) => p.text)).toEqual([
			"A paragraph should be read.",
		]);
		source.destroy();
	});

	it("uses the Twitter extractor for x.com status pages", () => {
		appendTweet(document.body, "This is the tweet body. It should be read.");

		const source = createContentSource(
			new URL("https://x.com/user/status/123"),
			document,
		);
		const paragraphs = source.getParagraphs();

		expect(source.site).toBe("twitter");
		expect(source.metadata.hasPlayableContent).toBe(true);
		expect(source.metadata.autoShow).toBe(true);
		expect(source.metadata.playbackMode).toBe("single");
		expect(paragraphs).toHaveLength(1);
		expect(paragraphs[0].source).toBe("twitter");
		expect(paragraphs[0].text).toBe(
			"This is the tweet body. It should be read.",
		);
		expect(paragraphs[0].sentences).toHaveLength(2);
		source.destroy();
	});

	it("updates Twitter paragraphs when tweets are streamed into the DOM later", async () => {
		const main = document.createElement("main");
		document.body.appendChild(main);
		makeVisible(main);
		const source = createContentSource(
			new URL("https://twitter.com/home"),
			document,
		);
		const onChange = vi.fn();
		source.subscribe(onChange);

		appendTweet(main, "A dynamically loaded tweet appears. Read it.");

		await Promise.resolve();
		vi.runAllTimers();

		expect(source.getParagraphs().map((p) => p.text)).toEqual([
			"A dynamically loaded tweet appears. Read it.",
		]);
		expect(source.metadata.hasPlayableContent).toBe(true);
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ paragraphs: source.getParagraphs() }),
		);
		source.destroy();
	});

	it("ignores hidden Twitter tweet text", () => {
		appendTweet(document.body, "Hidden tweet.", { ariaHidden: true });

		const source = createContentSource(
			new URL("https://x.com/user/status/123"),
			document,
		);

		expect(source.getParagraphs()).toEqual([]);
		expect(source.metadata.hasPlayableContent).toBe(false);
		source.destroy();
	});
});

describe("extractContent compatibility", () => {
	it("still exposes the original generic extraction API", () => {
		appendTextElement(document.body, "p", "Existing API still works.");

		expect(extractContent().map((p) => p.text)).toEqual([
			"Existing API still works.",
		]);
	});
});
