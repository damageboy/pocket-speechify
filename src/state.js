import { VOICES, DEFAULT_VOICE_ID } from "./voices.js";
import {
	DEFAULT_LANGUAGE_ID,
	getDefaultVoiceForLanguage,
} from "./languages.js";

function voiceCacheKey(languageId, voiceId) {
	return `${languageId}:${voiceId}`;
}

function languageIdForVoice(voice) {
	return voice.lang === "french" ? "french_24l" : voice.lang;
}

function buildEmptyVoiceCache() {
	const entries = VOICES.map((voice) => [
		voiceCacheKey(languageIdForVoice(voice), voice.id),
		"uncached",
	]);
	entries.push([
		voiceCacheKey(DEFAULT_LANGUAGE_ID, DEFAULT_VOICE_ID),
		"uncached",
	]);
	return Object.fromEntries(entries);
}

const INITIAL_STATE = {
	playback: "idle",
	currentParagraphIndex: null,
	currentSentenceIndex: null,
	currentWordIndex: null,
	speed: 1.0,
	selectedLanguage: DEFAULT_LANGUAGE_ID,
	detectedLanguage: null,
	languageSource: "fallback",
	siteKey: "",
	voiceId: DEFAULT_VOICE_ID,
	panelOpen: null,
	pillExpanded: false,
	totalDurationSec: 0,
	elapsedSec: 0,
	elapsedOffsetSec: 0,
	modelCached: false,
	voiceCache: null,
	downloadProgress: null,
	hasPlayableContent: false,
};

export function createState(initialPatch = {}) {
	const bus = new EventTarget();
	const initialLanguage =
		initialPatch.selectedLanguage || INITIAL_STATE.selectedLanguage;
	const initialVoice =
		initialPatch.voiceId || getDefaultVoiceForLanguage(initialLanguage);
	const initialState = {
		...INITIAL_STATE,
		...initialPatch,
		selectedLanguage: initialLanguage,
		voiceId: initialVoice,
		voiceCache: buildEmptyVoiceCache(),
	};
	let state = { ...initialState };

	function get() {
		return { ...state };
	}

	function dispatch(patch) {
		const prev = state;
		const next = { ...state, ...patch };
		// Skip if nothing changed
		const changed = Object.keys(patch).some((k) => next[k] !== prev[k]);
		if (!changed) return;
		state = next;
		bus.dispatchEvent(
			new CustomEvent("statechange", {
				detail: { current: { ...state }, prev },
			}),
		);
	}

	function subscribe(fn) {
		bus.addEventListener("statechange", (e) =>
			fn(e.detail.current, e.detail.prev),
		);
	}

	function reset() {
		dispatch({ ...initialState, voiceCache: buildEmptyVoiceCache() });
	}

	return {
		get,
		dispatch,
		subscribe,
		reset,
		buildEmptyVoiceCache,
		voiceCacheKey,
	};
}
