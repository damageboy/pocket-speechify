import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	await initPillPlayer(shadow, state, actions, paragraphs, options);

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

	it("updates open history on submissions, including after clearing it", async () => {
		const { shadow, state } = await renderPill();
		shadow.querySelector('[aria-label="Settings"]').click();
		[...shadow.querySelectorAll('.settings-nav-item')].find(button => button.textContent === 'History').click();
		const body = shadow.querySelector('.settings-content-body');
		const rows = () => [...body.querySelectorAll('tbody tr')].map(row => row.textContent);
		expect(body.textContent).toContain('No entries yet');
		expect(body.querySelector('button').disabled).toBe(true);

		state.dispatch({ ttsHistory: [{ paragraphIndex: 2, text: 'First processed paragraph.' }] });
		expect(rows()).toEqual(['1First processed paragraph.']);
		expect(body.textContent).toContain('1 entry');
		expect(body.querySelector('button').disabled).toBe(false);
		body.querySelector('table').parentElement.scrollTop = 75;

		state.dispatch({ ttsHistory: [
			...state.get().ttsHistory,
			{ paragraphIndex: 4, text: 'Next <processed> paragraph.' },
		] });
		expect(rows()).toEqual(['1First processed paragraph.', '2Next <processed> paragraph.']);
		expect(body.textContent).toContain('2 entries');
		expect(body.querySelector('table').parentElement.scrollTop).toBe(75);
		const table = body.querySelector('table');
		state.dispatch({ currentWordIndex: 3 });
		expect(body.querySelector('table')).toBe(table);

		body.querySelector('button').click();
		expect(state.get().ttsHistory).toEqual([]);
		expect(rows()).toEqual([]);
		expect(body.textContent).toContain('No entries yet');
		expect(body.querySelector('button').disabled).toBe(true);
		state.dispatch({ ttsHistory: [{ paragraphIndex: 5, text: 'After clearing.' }] });
		expect(rows()).toEqual(['1After clearing.']);
	});

	it.each(['Close settings', 'Settings'])("stops updating closed history via %s and refreshes on reopening", async (closeLabel) => {
		const { shadow, state } = await renderPill();
		const settings = shadow.querySelector('[aria-label="Settings"]');
		const selectHistory = () => [...shadow.querySelectorAll('.settings-nav-item')].find(button => button.textContent === 'History').click();
		settings.click();
		const slider = shadow.querySelector('.settings-slider');
		state.dispatch({ ttsHistory: [{ paragraphIndex: 0, text: 'While General is open.' }] });
		expect(shadow.querySelector('.settings-slider')).toBe(slider);
		selectHistory();
		const closedBody = shadow.querySelector('.settings-content-body');
		expect(closedBody.textContent).toContain('While General is open.');
		shadow.querySelector(`[aria-label="${closeLabel}"]`).click();
		expect(shadow.querySelector('.settings-dialog')).toBeNull();
		state.dispatch({ ttsHistory: [...state.get().ttsHistory, { paragraphIndex: 1, text: 'While closed.' }] });
		expect(closedBody.textContent).not.toContain('While closed.');
		settings.click();
		selectHistory();
		expect(shadow.querySelector('.settings-content-body').textContent).toContain('While closed.');
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

describe("pinch zoom (visual viewport)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the pill inside the visible area while zoomed and restores the CSS position at scale 1", async () => {
		const vv = Object.assign(new EventTarget(), {
			scale: 1,
			offsetLeft: 0,
			offsetTop: 0,
			width: 1265,
			height: 800,
		});
		vi.stubGlobal("visualViewport", vv);

		const { pill } = await renderPill({
			paragraphs: [{ text: "Playable text." }],
			options: { hasPlayableContent: true },
		});
		// happy-dom has no layout engine: clientWidth is 0 and rects are empty, so
		// pin the numbers a zoomed browser reports for a 1265x800 layout viewport.
		Object.defineProperty(document.documentElement, "clientWidth", {
			value: 1265,
			configurable: true,
		});
		vi.spyOn(pill, "getBoundingClientRect").mockReturnValue({ height: 218 });

		// Pinch zoom to 2x anchored at the top-left of the layout viewport.
		vv.scale = 2;
		vv.width = 632.5;
		vv.height = 400;
		vv.dispatchEvent(new Event("resize"));

		// 1265 - (0 + 632.5) + 18 / 2 = 641.5 -> 18 screen px from the visible right edge
		expect(pill.style.right).toBe("641.5px");
		// 0 + 400 / 2 - 218 / 2 = 91 -> vertically centered in the visible area
		expect(pill.style.top).toBe("91px");

		// Panning while zoomed moves the visible area: visualViewport scroll event.
		vv.offsetLeft = 50;
		vv.offsetTop = 100;
		vv.dispatchEvent(new Event("scroll"));
		expect(pill.style.right).toBe("591.5px");
		expect(pill.style.top).toBe("191px");

		// Back to 100%: the stylesheet owns the position again.
		vv.scale = 1;
		vv.offsetLeft = 0;
		vv.offsetTop = 0;
		vv.width = 1265;
		vv.height = 800;
		vv.dispatchEvent(new Event("resize"));
		expect(pill.style.right).toBe("");
		expect(pill.style.top).toBe("");
	});
});
