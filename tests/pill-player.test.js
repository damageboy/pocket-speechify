import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { initPillPlayer } from "../src/pill-player.js";
import { createState } from "../src/state.js";

function createShadow() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	return host.attachShadow({ mode: "open" });
}

function createActions() {
	return {
		play: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		skipBack: vi.fn(),
		skipForward: vi.fn(),
	};
}

async function renderPill({ paragraphs = [], options } = {}) {
	const shadow = createShadow();
	const state = createState();
	const actions = createActions();

	await initPillPlayer(shadow, state, actions, paragraphs, [], options);

	return {
		shadow,
		state,
		actions,
		pill: shadow.querySelector(".pill-container"),
	};
}

beforeEach(() => {
	fakeBrowser.reset();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.stubGlobal("chrome", {
		storage: {
			local: {
				get: vi.fn().mockResolvedValue({}),
				set: vi.fn(),
			},
		},
		runtime: {
			getManifest: vi.fn(() => ({
				name: "Pocket Speechify",
				version: "0.0.0",
			})),
			sendMessage: vi.fn(),
		},
	});
});

describe("initPillPlayer", () => {
	it("initializes hidden when initiallyVisible is false", async () => {
		const { pill } = await renderPill({
			paragraphs: [{ text: "Playable text." }],
			options: { initiallyVisible: false },
		});

		expect(pill).not.toBeNull();
		expect(pill.style.display).toBe("none");
	});

	it("initializes visible by default when initiallyVisible is true", async () => {
		const { pill } = await renderPill({
			paragraphs: [{ text: "Playable text." }],
		});

		expect(pill).not.toBeNull();
		expect(pill.style.display).toBe("");
	});

	it("disables play when hasPlayableContent is false even if paragraphs exist", async () => {
		const { shadow, actions } = await renderPill({
			paragraphs: [{ text: "Existing paragraph that should not be playable." }],
			options: { hasPlayableContent: false },
		});

		const playButton = shadow.querySelector('button[aria-label="Play"]');
		expect(playButton).not.toBeNull();
		expect(playButton.classList.contains("btn-disabled")).toBe(true);

		playButton.click();

		expect(actions.play).not.toHaveBeenCalled();
	});

	it("calls actions.play when hasPlayableContent is true", async () => {
		const { shadow, actions } = await renderPill({
			paragraphs: [],
			options: { hasPlayableContent: true },
		});

		const playButton = shadow.querySelector('button[aria-label="Play"]');
		expect(playButton).not.toBeNull();

		playButton.click();

		expect(actions.play).toHaveBeenCalledTimes(1);
	});

	it("enables the idle play button when playable content appears dynamically", async () => {
		const { shadow, state, actions } = await renderPill({
			paragraphs: [],
			options: { hasPlayableContent: false },
		});

		const disabledPlayButton = shadow.querySelector(
			'button[aria-label="Play"]',
		);
		expect(disabledPlayButton.classList.contains("btn-disabled")).toBe(true);

		state.dispatch({ hasPlayableContent: true });

		const enabledPlayButton = shadow.querySelector('button[aria-label="Play"]');
		expect(enabledPlayButton.classList.contains("btn-disabled")).toBe(false);

		enabledPlayButton.click();

		expect(actions.play).toHaveBeenCalledTimes(1);
	});
});
