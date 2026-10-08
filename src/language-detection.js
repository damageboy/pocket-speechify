import { getDomain } from "tldts";
import {
	DEFAULT_LANGUAGE_ID,
	getLanguage,
	isSupportedLanguage,
	languageFromLocale,
} from "./languages.js";

export const LANGUAGE_OVERRIDES_KEY = "pocket-speechify-language-overrides";
const SPEECH_SELECTION_KEY = "pocket-speechify-speech-selection";

export function getSiteLanguageKey(hostname) {
	const host = String(hostname || "").toLowerCase();
	if (!host) return "";
	const domain = getDomain(host, { allowPrivateDomains: true });
	return domain || host;
}

function isPlainObject(value) {
	if (!value || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function normalizeLanguageOverrides(value) {
	if (!isPlainObject(value)) return {};

	return Object.fromEntries(
		Object.entries(value).filter(([siteKey, languageId]) => {
			return Boolean(String(siteKey || "").trim()) && isSupportedLanguage(languageId);
		}),
	);
}

function getChromeStorageLocal() {
	return globalThis.chrome?.storage?.local || null;
}

async function loadSpeechSelection() {
	const storage = getChromeStorageLocal();
	if (typeof storage?.get !== "function") return null;

	try {
		const result = await storage.get(SPEECH_SELECTION_KEY);
		const selection = result?.[SPEECH_SELECTION_KEY];
		if (!isPlainObject(selection) ||
			typeof selection.selectedLanguage !== "string" ||
			!isSupportedLanguage(selection.selectedLanguage)) return null;
		const model = getLanguage(selection.selectedLanguage);
		return {
			selectedLanguage: model.id,
			voiceId: typeof selection.voiceId === "string" && Object.hasOwn(model.voices, selection.voiceId)
				? selection.voiceId : model.defaultVoice,
			speed: Number.isFinite(selection.speed) && selection.speed >= 0.4 && selection.speed <= 4.5
				? selection.speed : 1,
		};
	} catch {
		return null;
	}
}

export async function saveSpeechSelection(selectedLanguage, voiceId, speed) {
	const storage = getChromeStorageLocal();
	if (typeof storage?.set !== "function") return;

	try {
		// One write keeps the model, voice and speed together across tabs.
		await storage.set({ [SPEECH_SELECTION_KEY]: { selectedLanguage, voiceId, speed } });
	} catch (error) {
		console.warn("[Pocket Speechify] Could not save model, voice and speed selection:", error);
	}
}

function metaContent(doc, selector) {
	if (typeof doc?.querySelector !== "function") return "";
	return doc.querySelector(selector)?.getAttribute("content")?.trim() || "";
}

function getDocumentLang(doc) {
	const documentElement = doc?.documentElement;
	if (typeof documentElement?.getAttribute !== "function") return "";
	return documentElement.getAttribute("lang") || "";
}

export function detectMetadataLanguage(doc = globalThis.document) {
	if (!doc) return null;

	const candidates = [
		getDocumentLang(doc),
		metaContent(doc, 'meta[property="og:locale"]'),
		metaContent(doc, 'meta[http-equiv="content-language" i]'),
		metaContent(doc, 'meta[name="language" i]'),
	];

	for (const raw of candidates) {
		const language = languageFromLocale(raw);
		if (language) return { language, raw };
	}
	return null;
}

export async function loadLanguageOverrides() {
	const storage = getChromeStorageLocal();
	if (typeof storage?.get !== "function") return {};

	try {
		const result = await storage.get(LANGUAGE_OVERRIDES_KEY);
		if (!isPlainObject(result)) return {};
		return normalizeLanguageOverrides(result[LANGUAGE_OVERRIDES_KEY]);
	} catch {
		return {};
	}
}

export async function saveLanguageOverride(siteKey, languageId) {
	const normalizedSiteKey = String(siteKey || "").trim().toLowerCase();
	if (!normalizedSiteKey || !isSupportedLanguage(languageId)) return;

	const storage = getChromeStorageLocal();
	if (typeof storage?.set !== "function") return;

	const overrides = await loadLanguageOverrides();
	await storage.set({
		[LANGUAGE_OVERRIDES_KEY]: {
			...overrides,
			[normalizedSiteKey]: languageId,
		},
	});
}

function hostnameFromUrl(url) {
	if (!url) return "";
	if (typeof url.hostname === "string") return url.hostname;

	const href = typeof url === "string" ? url : url.href;
	if (typeof href !== "string" || !href) return "";

	try {
		return new URL(href).hostname;
	} catch {
		return "";
	}
}

export async function resolvePageLanguage(url, doc = globalThis.document) {
	const resolvedUrl = url === undefined ? globalThis.location?.href : url;
	const siteKey = getSiteLanguageKey(hostnameFromUrl(resolvedUrl));
	const detected = detectMetadataLanguage(doc);
	const selection = await loadSpeechSelection();
	if (selection) {
		return {
			...selection,
			siteKey,
			detectedLanguage: detected?.language || null,
			languageSource: "preference",
		};
	}

	// Retain older per-site choices until the user makes a global selection.
	const overrides = await loadLanguageOverrides();
	const override = overrides[siteKey];

	if (override && isSupportedLanguage(override)) {
		return {
			siteKey,
			selectedLanguage: override,
			detectedLanguage: detected?.language || null,
			languageSource: "override",
		};
	}

	if (detected) {
		return {
			siteKey,
			selectedLanguage: detected.language,
			detectedLanguage: detected.language,
			languageSource: "metadata",
		};
	}

	return {
		siteKey,
		selectedLanguage: DEFAULT_LANGUAGE_ID,
		detectedLanguage: null,
		languageSource: "fallback",
	};
}
