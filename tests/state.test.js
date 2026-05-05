import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { createState } from "../src/state.js";
import {
	DEFAULT_LANGUAGE_ID,
	getDefaultVoiceForLanguage,
} from "../src/languages.js";

// WxtVitest sets up fake-browser, but voices.js uses `browser.runtime.getURL`.
// fakeBrowser provides an in-memory browser implementation.
beforeEach(() => {
	fakeBrowser.reset();
});

describe("createState", () => {
	it("has correct default state", () => {
		const state = createState();
		const s = state.get();
		expect(s.playback).toBe("idle");
		expect(s.speed).toBe(1.0);
		expect(s.currentParagraphIndex).toBeNull();
		expect(s.currentSentenceIndex).toBeNull();
		expect(s.currentWordIndex).toBeNull();
		expect(s.panelOpen).toBeNull();
		expect(s.pillExpanded).toBe(false);
		expect(s.totalDurationSec).toBe(0);
		expect(s.elapsedSec).toBe(0);
		expect(s.modelCached).toBe(false);
		expect(s.downloadProgress).toBeNull();
		expect(s.selectedLanguage).toBe(DEFAULT_LANGUAGE_ID);
		expect(s.detectedLanguage).toBeNull();
		expect(s.languageSource).toBe("fallback");
		expect(s.voiceId).toBe(getDefaultVoiceForLanguage(DEFAULT_LANGUAGE_ID));
	});

	it("initializes language state", () => {
		const state = createState({
			selectedLanguage: "german",
			detectedLanguage: "german",
			languageSource: "metadata",
		});
		expect(state.get()).toMatchObject({
			selectedLanguage: "german",
			detectedLanguage: "german",
			languageSource: "metadata",
			voiceId: getDefaultVoiceForLanguage("german"),
		});
	});

	it("voiceCache has an entry per voice defaulting to uncached", () => {
		const state = createState();
		const { voiceCache } = state.get();
		expect(typeof voiceCache).toBe("object");
		expect(Object.values(voiceCache).every((v) => v === "uncached")).toBe(true);
		expect(Object.keys(voiceCache).length).toBeGreaterThan(0);
	});

	it("builds language-scoped voice cache keys", () => {
		const state = createState();
		expect(state.get().voiceCache["english:alba"]).toBe("uncached");
		expect(state.get().voiceCache["german:juergen"]).toBe("uncached");
	});

	it("dispatch merges a partial patch into state", () => {
		const state = createState();
		state.dispatch({ playback: "playing", speed: 1.5 });
		const s = state.get();
		expect(s.playback).toBe("playing");
		expect(s.speed).toBe(1.5);
		// Unrelated fields preserved
		expect(s.currentParagraphIndex).toBeNull();
	});

	it("get() returns a copy, not the internal state reference", () => {
		const state = createState();
		const s1 = state.get();
		s1.speed = 99;
		expect(state.get().speed).toBe(1.0);
	});

	it("subscribe fires with current and previous state on change", () => {
		const state = createState();
		const calls = [];
		state.subscribe((current, prev) => calls.push({ current, prev }));

		state.dispatch({ speed: 2.0 });

		expect(calls).toHaveLength(1);
		expect(calls[0].current.speed).toBe(2.0);
		expect(calls[0].prev.speed).toBe(1.0);
	});

	it("subscribe fires for each distinct dispatch", () => {
		const state = createState();
		const calls = [];
		state.subscribe((current) => calls.push(current.speed));

		state.dispatch({ speed: 1.5 });
		state.dispatch({ speed: 2.0 });

		expect(calls).toEqual([1.5, 2.0]);
	});

	it("dispatch does NOT fire subscribe when values are unchanged", () => {
		const state = createState();
		const fn = vi.fn();
		state.subscribe(fn);

		state.dispatch({ speed: 1.0 }); // same as default
		state.dispatch({ playback: "idle" }); // same as default

		expect(fn).not.toHaveBeenCalled();
	});

	it("dispatch does NOT fire when patching same value after a change", () => {
		const state = createState();
		state.dispatch({ speed: 1.5 });

		const fn = vi.fn();
		state.subscribe(fn);
		state.dispatch({ speed: 1.5 }); // same value again

		expect(fn).not.toHaveBeenCalled();
	});

	it("reset restores initial state", () => {
		const state = createState();
		state.dispatch({
			playback: "playing",
			speed: 2.5,
			currentParagraphIndex: 3,
		});
		state.reset();
		const s = state.get();
		expect(s.playback).toBe("idle");
		expect(s.speed).toBe(1.0);
		expect(s.currentParagraphIndex).toBeNull();
	});
});
