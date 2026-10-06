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
	if (attributes.statusUrl) {
		const statusLink = document.createElement("a");
		statusLink.href = attributes.statusUrl;
		statusLink.textContent = "status";
		article.appendChild(statusLink);
		makeVisible(statusLink);
	}
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
	vi.restoreAllMocks();
});

describe("createContentSource", () => {
	it.each(["generic", "twitter"])("refreshes %s during continuous text updates", async site => {
		const element = site === "twitter"
			? appendTweet(document.body, "Initial.")
			: appendTextElement(document.body, "p", "Initial.");
		const source = createContentSource(new URL(site === "twitter" ? "https://x.com" : "https://example.com"), document);
		try {
			for (let i = 0; i < 3; i++) {
				element.firstChild.data = `Update ${i}.`;
				await vi.advanceTimersByTimeAsync(40);
			}
			// A trailing debounce would still expose Initial. until the stream stops.
			expect(source.getParagraphs()[0].text).toBe("Update 2.");
			element.firstChild.data = "Final.";
			await vi.advanceTimersByTimeAsync(120);
			expect(source.getParagraphs()[0].text).toBe("Final.");
		} finally {
			source.destroy();
		}
	});

	it("debounces generic changes, preserves objects, and notifies only changed output", async () => {
		const first = appendTextElement(document.body, "p", "First.");
		const source = createContentSource(new URL("https://example.com"), document);
		const paragraphs = source.getParagraphs();
		const original = paragraphs[0];
		const changed = vi.fn();
		source.subscribe(changed);
		const settle = async () => { await Promise.resolve(); vi.runAllTimers(); };
		const second = appendTextElement(document.body, "p", "Second.");
		second.firstChild.data = "Updated.";
		await settle();
		expect(paragraphs.map(p => p.text)).toEqual(["First.", "Updated."]);
		expect(source.getParagraphs()).toBe(paragraphs);
		expect(paragraphs[0]).toBe(original);
		expect(changed).toHaveBeenCalledTimes(1);
		second.style.visibility = "hidden";
		await settle();
		expect(paragraphs).toEqual([original]);
		first.replaceWith(first.cloneNode(true));
		await settle();
		expect(paragraphs[0]).not.toBe(original);
		expect(changed).toHaveBeenCalledTimes(3);
		document.querySelector("p").remove();
		await settle();
		expect(paragraphs).toEqual([]);
		expect(changed).toHaveBeenCalledTimes(4);
		source.destroy();
		appendTextElement(document.body, "p", "After destroy.");
		await settle();
		expect(changed).toHaveBeenCalledTimes(4);
	});

	it.each(["generic", "twitter"])("ignores own and unrelated %s mutations without refreshing", async (site) => {
		if (site === "twitter") appendTweet(document.body, "Tweet.");
		else appendTextElement(document.body, "p", "Prose.");
		const unrelated = appendTextElement(document.body, "div", "Outside.");
		const source = createContentSource(new URL(site === "twitter" ? "https://x.com" : "https://example.com"), document);
		const original = source.getParagraphs()[0];
		const changed = vi.fn();
		source.subscribe(changed);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		unrelated.firstChild.data = "Unrelated.";
		const overlay = document.createElement("p");
		overlay.dataset.psHighlight = "word";
		document.body.append(overlay);
		overlay.remove();
		await Promise.resolve();
		vi.runAllTimers();
		expect(changed).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
		expect(source.getParagraphs()[0]).toBe(original);
		source.destroy();
	});

	it.each(["generic", "twitter"])("refreshes %s for text and ancestor visibility changes while reusing unaffected paragraphs", async (site) => {
		const container = document.createElement("section");
		document.body.append(container);
		const append = text => site === "twitter" ? appendTweet(container, text) : appendTextElement(container, "p", text);
		const first = append("First.");
		append("Second.");
		const source = createContentSource(new URL(site === "twitter" ? "https://x.com" : "https://example.com"), document);
		const unchanged = source.getParagraphs()[1];
		const changed = vi.fn();
		const unsubscribe = source.subscribe(changed);
		const settle = async () => { await Promise.resolve(); vi.runAllTimers(); };
		first.firstChild.data = "Edited.";
		await settle();
		expect(source.getParagraphs().map(p => p.text)).toEqual(["Edited.", "Second."]);
		expect(source.getParagraphs()[1]).toBe(unchanged);
		container.setAttribute("aria-hidden", "true");
		await settle();
		expect(source.getParagraphs()).toEqual([]);
		container.removeAttribute("aria-hidden");
		await settle();
		expect(source.getParagraphs()).toHaveLength(2);
		expect(changed).toHaveBeenCalledTimes(3);
		container.style.display = "contents";
		await settle();
		expect(changed).toHaveBeenCalledTimes(3);
		unsubscribe();
		first.textContent = "After unsubscribe.";
		await settle();
		expect(changed).toHaveBeenCalledTimes(3);
		source.destroy();
	});

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

	it("ignores mutations from its own highlight overlays and scroll-nav", async () => {
		appendTweet(document.body, "A tweet being read aloud.");
		const source = createContentSource(
			new URL("https://x.com/home"),
			document,
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const refreshes = () =>
			log.mock.calls.filter(([message]) =>
				String(message).includes("Twitter extractor refresh triggered"),
			).length;

		const overlay = document.createElement("div");
		overlay.setAttribute("data-ps-highlight", "word");
		document.body.appendChild(overlay);
		overlay.remove();
		const pill = document.createElement("div");
		pill.setAttribute("data-ps-scrollnav", "true");
		document.body.appendChild(pill);
		pill.textContent = "word";
		await Promise.resolve();
		vi.runAllTimers();
		expect(refreshes()).toBe(0);

		appendTweet(document.body, "A new tweet arrives.");
		await Promise.resolve();
		vi.runAllTimers();
		expect(refreshes()).toBe(1);
		source.destroy();
	});

	it("keeps distinct tweets with identical text when status URLs differ", () => {
		appendTweet(document.body, "Same words from different tweets.", {
			statusUrl: "https://x.com/alice/status/111",
		});
		appendTweet(document.body, "Same words from different tweets.", {
			statusUrl: "https://x.com/bob/status/222",
		});

		const source = createContentSource(new URL("https://x.com/home"), document);

		expect(source.getParagraphs().map((p) => p.text)).toEqual([
			"Same words from different tweets.",
			"Same words from different tweets.",
		]);
		expect(source.getParagraphs().map((p) => p.twitterIdentity)).toEqual([
			"status:https://x.com/alice/status/111",
			"status:https://x.com/bob/status/222",
		]);
		source.destroy();
	});

	it("notifies subscribers when Twitter replaces a tweet node with the same status and text", async () => {
		appendTweet(document.body, "Same tweet rendered again.", {
			statusUrl: "https://x.com/alice/status/111",
		});
		const source = createContentSource(
			new URL("https://x.com/alice/status/111"),
			document,
		);
		const firstElement = source.getParagraphs()[0].element;
		const onChange = vi.fn();
		source.subscribe(onChange);

		document.body.replaceChildren();
		appendTweet(document.body, "Same tweet rendered again.", {
			statusUrl: "https://x.com/alice/status/111",
		});
		await Promise.resolve();
		vi.runAllTimers();

		expect(source.getParagraphs()[0].element).not.toBe(firstElement);
		expect(source.getParagraphs()[0].twitterIdentity).toBe(
			"status:https://x.com/alice/status/111",
		);
		expect(onChange).toHaveBeenCalledTimes(1);
		source.destroy();
	});

	it("does not log per-tweet text or identity diagnostics", () => {
		const fullTweetText =
			"A text-only tweet identity should stay available for dedupe, but the full text should not be repeated inside the logged identity field. This tail must not appear in the identity.";
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		appendTweet(document.body, fullTweetText);

		const source = createContentSource(new URL("https://x.com/home"), document);
		const detectedLog = logSpy.mock.calls
			.map((call) => String(call[0]))
			.find((message) => message.includes("Twitter tweet detected"));

		expect(source.getParagraphs()[0].twitterIdentity).toBe(
			`text:${fullTweetText}`,
		);
		expect(detectedLog).toBeUndefined();
		expect(logSpy.mock.calls.map(call => String(call[0])).join("\n")).not.toContain(fullTweetText);
		source.destroy();
		logSpy.mockRestore();
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
