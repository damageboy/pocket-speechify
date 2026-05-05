import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	LANGUAGE_OVERRIDES_KEY,
	detectMetadataLanguage,
	getSiteLanguageKey,
	loadLanguageOverrides,
	resolvePageLanguage,
	saveLanguageOverride,
} from "../src/language-detection.js";

beforeEach(() => {
	document.head.replaceChildren();
	document.body.replaceChildren();
	document.documentElement.removeAttribute("lang");
	globalThis.chrome = {
		storage: {
			local: {
				get: vi.fn(async () => ({})),
				set: vi.fn(async () => {}),
			},
		},
	};
});

describe("getSiteLanguageKey", () => {
	it("uses registrable domains for subdomains", () => {
		expect(getSiteLanguageKey("www.news.example.co.uk")).toBe("example.co.uk");
	});

	it("keeps localhost and IP hosts exact", () => {
		expect(getSiteLanguageKey("localhost")).toBe("localhost");
		expect(getSiteLanguageKey("127.0.0.1")).toBe("127.0.0.1");
	});
});

describe("detectMetadataLanguage", () => {
	it("detects html lang before metadata tags", () => {
		document.documentElement.lang = "de-DE";
		const meta = document.createElement("meta");
		meta.setAttribute("property", "og:locale");
		meta.content = "en_US";
		document.head.appendChild(meta);
		expect(detectMetadataLanguage(document)).toEqual({
			language: "german",
			raw: "de-DE",
		});
	});

	it("detects og locale", () => {
		const meta = document.createElement("meta");
		meta.setAttribute("property", "og:locale");
		meta.content = "fr_FR";
		document.head.appendChild(meta);
		expect(detectMetadataLanguage(document).language).toBe("french_24l");
	});

	it("returns null for unsupported metadata", () => {
		document.documentElement.lang = "nl-NL";
		expect(detectMetadataLanguage(document)).toBe(null);
	});

	it("does not throw for missing or partial documents", () => {
		expect(detectMetadataLanguage(null)).toBe(null);
		expect(detectMetadataLanguage({})).toBe(null);
		expect(detectMetadataLanguage({ documentElement: {} })).toBe(null);
	});

	it("does not throw when no global document is available", () => {
		const originalDocument = globalThis.document;
		vi.stubGlobal("document", undefined);
		try {
			expect(detectMetadataLanguage()).toBe(null);
		} finally {
			vi.stubGlobal("document", originalDocument);
		}
	});
});

describe("loadLanguageOverrides", () => {
	it("returns empty overrides when chrome storage is missing", async () => {
		delete globalThis.chrome;
		await expect(loadLanguageOverrides()).resolves.toEqual({});
	});

	it("returns empty overrides when local storage is unavailable", async () => {
		globalThis.chrome = { storage: {} };
		await expect(loadLanguageOverrides()).resolves.toEqual({});
	});

	it("returns empty overrides when storage get rejects", async () => {
		chrome.storage.local.get.mockRejectedValue(new Error("storage failed"));
		await expect(loadLanguageOverrides()).resolves.toEqual({});
	});

	it("returns empty overrides for corrupt stored override shapes", async () => {
		for (const storedValue of [null, "spanish", ["spanish"]]) {
			chrome.storage.local.get.mockResolvedValueOnce({
				[LANGUAGE_OVERRIDES_KEY]: storedValue,
			});
			await expect(loadLanguageOverrides()).resolves.toEqual({});
		}
	});

	it("filters unsupported languages and empty site keys from stored overrides", async () => {
		chrome.storage.local.get.mockResolvedValue({
			[LANGUAGE_OVERRIDES_KEY]: {
				"": "spanish",
				"example.com": "klingon",
				"valid.com": "german",
			},
		});
		await expect(loadLanguageOverrides()).resolves.toEqual({
			"valid.com": "german",
		});
	});
});

describe("resolvePageLanguage", () => {
	it("uses domain override before metadata", async () => {
		chrome.storage.local.get.mockResolvedValue({
			[LANGUAGE_OVERRIDES_KEY]: { "example.com": "spanish" },
		});
		document.documentElement.lang = "de-DE";
		await expect(
			resolvePageLanguage(new URL("https://news.example.com/story"), document),
		).resolves.toMatchObject({
			selectedLanguage: "spanish",
			detectedLanguage: "german",
			languageSource: "override",
			siteKey: "example.com",
		});
	});

	it("uses metadata if no override exists", async () => {
		document.documentElement.lang = "it-IT";
		await expect(
			resolvePageLanguage(new URL("https://example.com"), document),
		).resolves.toMatchObject({
			selectedLanguage: "italian",
			languageSource: "metadata",
		});
	});

	it("falls back to English silently", async () => {
		await expect(
			resolvePageLanguage(new URL("https://example.com"), document),
		).resolves.toMatchObject({
			selectedLanguage: "english",
			detectedLanguage: null,
			languageSource: "fallback",
		});
	});

	it("uses metadata when chrome storage is missing", async () => {
		delete globalThis.chrome;
		document.documentElement.lang = "fr-FR";
		await expect(
			resolvePageLanguage(new URL("https://example.com"), document),
		).resolves.toMatchObject({
			selectedLanguage: "french_24l",
			detectedLanguage: "french_24l",
			languageSource: "metadata",
		});
	});

	it("falls back when chrome storage and metadata are missing", async () => {
		delete globalThis.chrome;
		await expect(
			resolvePageLanguage(new URL("https://example.com"), document),
		).resolves.toMatchObject({
			selectedLanguage: "english",
			detectedLanguage: null,
			languageSource: "fallback",
		});
	});

	it("does not throw for null or partial doc/url data", async () => {
		await expect(resolvePageLanguage(null, null)).resolves.toMatchObject({
			siteKey: "",
			selectedLanguage: "english",
			detectedLanguage: null,
			languageSource: "fallback",
		});
		await expect(resolvePageLanguage({}, {})).resolves.toMatchObject({
			siteKey: "",
			selectedLanguage: "english",
			detectedLanguage: null,
			languageSource: "fallback",
		});
	});

	it("ignores unsupported stored overrides in favor of metadata", async () => {
		chrome.storage.local.get.mockResolvedValue({
			[LANGUAGE_OVERRIDES_KEY]: { "example.com": "klingon" },
		});
		document.documentElement.lang = "de-DE";
		await expect(
			resolvePageLanguage(new URL("https://example.com"), document),
		).resolves.toMatchObject({
			selectedLanguage: "german",
			detectedLanguage: "german",
			languageSource: "metadata",
		});
	});

	it("ignores unsupported stored overrides in favor of fallback", async () => {
		chrome.storage.local.get.mockResolvedValue({
			[LANGUAGE_OVERRIDES_KEY]: { "example.com": "klingon" },
		});
		await expect(
			resolvePageLanguage(new URL("https://example.com"), document),
		).resolves.toMatchObject({
			selectedLanguage: "english",
			detectedLanguage: null,
			languageSource: "fallback",
		});
	});
});

describe("saveLanguageOverride", () => {
	it("merges new override into storage", async () => {
		chrome.storage.local.get.mockResolvedValue({
			[LANGUAGE_OVERRIDES_KEY]: { "old.com": "german" },
		});
		await saveLanguageOverride("example.com", "spanish");
		expect(chrome.storage.local.set).toHaveBeenCalledWith({
			[LANGUAGE_OVERRIDES_KEY]: {
				"old.com": "german",
				"example.com": "spanish",
			},
		});
	});

	it("does not save empty site keys", async () => {
		await saveLanguageOverride("", "spanish");
		await saveLanguageOverride("   ", "spanish");
		expect(chrome.storage.local.set).not.toHaveBeenCalled();
	});

	it("does not save unsupported languages", async () => {
		await saveLanguageOverride("example.com", "klingon");
		expect(chrome.storage.local.set).not.toHaveBeenCalled();
	});
});
