import { getDomain } from "tldts";
import {
	DEFAULT_LANGUAGE_ID,
	isSupportedLanguage,
	languageFromLocale,
} from "./languages.js";

export const LANGUAGE_OVERRIDES_KEY = "pocket-speechify-language-overrides";

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
