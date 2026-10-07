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

	it("marks the pill as user-hidden when Turn Off is clicked", async () => {
		const { shadow, state, actions, pill } = await renderPill({
			paragraphs: [{ text: "Playable text." }],
			options: { hasPlayableContent: true },
		});

		const turnOffButton = shadow.querySelector('button[aria-label="Turn Off"]');
		turnOffButton.click();

		expect(actions.stop).toHaveBeenCalledTimes(1);
		expect(state.get().pillUserHidden).toBe(true);
		expect(pill.style.display).toBe("none");
	});

	it("offers only settings sections with working content", async () => {
		const { shadow } = await renderPill();
		shadow.querySelector('button[aria-label="Settings"]').click();
		const sections = [...shadow.querySelectorAll('.settings-nav-item')];
		expect(sections.map(button => button.textContent)).toEqual(['General', 'Text rules', 'Debug', 'History']);
		for (const section of sections) {
			section.click();
			expect(shadow.querySelector('.settings-content-body').textContent.trim()).not.toBe('');
		}
	});
});

describe("pill progress display", () => {
	it("shows remaining time and ring progress from state.progress", async () => {
		const { shadow, state } = await renderPill({
			paragraphs: [{ text: "Hello.", words: [{}], sentences: [] }],
			options: { initiallyVisible: true, hasPlayableContent: true },
		});
		const duration = () =>
			`${shadow.querySelector(".duration-mins").textContent}:${shadow.querySelector(".duration-secs").textContent}`;

		state.dispatch({ progress: { totalSec: 125, remainingSec: 125, percent: 0 } });
		expect(duration()).toBe("2:05");

		state.dispatch({
			playback: "playing",
			progress: { totalSec: 125, remainingSec: 62.2, percent: 50 },
		});
		expect(duration()).toBe("1:03");
		const arc = () => shadow.querySelector(".progress-ring svg path:last-of-type");
		const circumference = 2 * Math.PI * 46;
		expect(Number(arc().getAttribute("stroke-dashoffset"))).toBeCloseTo(circumference / 2, 0);

		state.dispatch({ progress: { totalSec: 125, remainingSec: 31, percent: 75 } });
		expect(duration()).toBe("0:31");
		expect(Number(arc().getAttribute("stroke-dashoffset"))).toBeCloseTo(circumference / 4, 0);
	});
});
