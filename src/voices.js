// src/voices.js

/**
 * Pocket-tts v2 voice definitions.
 * Voice IDs match the safetensors filenames on HuggingFace.
 * Gender from https://kyutai.github.io/pocket-tts/ voice metadata.
 */
export const VOICES = [
	{
		id: "alba",
		name: "Alba",
		lang: "english",
		gender: "m",
		style: "reading",
		hasAvatar: true,
	},
	{
		id: "anna",
		name: "Anna",
		lang: "english",
		gender: "f",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "azelma",
		name: "Azelma",
		lang: "english",
		gender: "f",
		style: "reading",
		hasAvatar: true,
	},
	{
		id: "bill_boerst",
		name: "Bill Boerst",
		lang: "english",
		gender: "m",
		style: "reading",
		hasAvatar: false,
	},
	{
		id: "caro_davy",
		name: "Caro Davy",
		lang: "english",
		gender: "f",
		style: "reading",
		hasAvatar: false,
	},
	{
		id: "charles",
		name: "Charles",
		lang: "english",
		gender: "m",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "cosette",
		name: "Cosette",
		lang: "english",
		gender: "f",
		style: "expressive",
		hasAvatar: true,
	},
	{
		id: "eponine",
		name: "Eponine",
		lang: "english",
		gender: "f",
		style: "reading",
		hasAvatar: true,
	},
	{
		id: "estelle",
		name: "Estelle",
		lang: "french",
		gender: "f",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "eve",
		name: "Eve",
		lang: "english",
		gender: "f",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "fantine",
		name: "Fantine",
		lang: "english",
		gender: "f",
		style: "reading",
		hasAvatar: true,
	},
	{
		id: "george",
		name: "George",
		lang: "english",
		gender: "m",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "giovanni",
		name: "Giovanni",
		lang: "italian",
		gender: "m",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "jane",
		name: "Jane",
		lang: "english",
		gender: "f",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "javert",
		name: "Javert",
		lang: "english",
		gender: "m",
		style: "conversation",
		hasAvatar: true,
	},
	{
		id: "jean",
		name: "Jean",
		lang: "english",
		gender: "m",
		style: "conversation",
		hasAvatar: true,
	},
	{
		id: "juergen",
		name: "Juergen",
		lang: "german",
		gender: "m",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "lola",
		name: "Lola",
		lang: "spanish",
		gender: "f",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "marius",
		name: "Marius",
		lang: "english",
		gender: "m",
		style: "conversation",
		hasAvatar: true,
	},
	{
		id: "mary",
		name: "Mary",
		lang: "english",
		gender: "f",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "michael",
		name: "Michael",
		lang: "english",
		gender: "m",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "paul",
		name: "Paul",
		lang: "english",
		gender: "m",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "peter_yearsley",
		name: "Peter Yearsley",
		lang: "english",
		gender: "m",
		style: "reading",
		hasAvatar: false,
	},
	{
		id: "rafael",
		name: "Rafael",
		lang: "portuguese",
		gender: "m",
		style: "conversation",
		hasAvatar: false,
	},
	{
		id: "stuart_bell",
		name: "Stuart Bell",
		lang: "english",
		gender: "m",
		style: "reading",
		hasAvatar: false,
	},
	{
		id: "vera",
		name: "Vera",
		lang: "english",
		gender: "f",
		style: "conversation",
		hasAvatar: false,
	},
];

export const DEFAULT_VOICE_ID = "alba";

const VOICE_BY_ID = Object.fromEntries(VOICES.map((v) => [v.id, v]));

export function getVoice(voiceId) {
	return VOICE_BY_ID[voiceId] || VOICE_BY_ID[DEFAULT_VOICE_ID];
}

export function voiceDisplayName(voiceId) {
	return voiceId
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function hasBundledVoiceAvatar(voiceId) {
	return Boolean(getVoice(voiceId).hasAvatar);
}

/**
 * Get the avatar URL for a voice ID.
 * Works in content scripts and extension pages.
 */
export function getVoiceAvatarUrl(voiceId) {
	return browser.runtime.getURL(`assets/voices/${voiceId}.webp`);
}
