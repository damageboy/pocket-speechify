import { describe, expect, it } from "vitest";
import {
	DEFAULT_LANGUAGE_ID,
	getDefaultVoiceForLanguage,
	getLanguage,
	languageFlag,
	languageFromLocale,
	buildLanguageConfigYaml,
	getModelCacheKey,
	getTokenizerCacheKey,
	getVoiceCacheKey,
	getModelUrl,
	getTokenizerUrl,
	getVoiceUrl,
} from "../src/languages.js";
import {
	VOICES,
	getVoice,
	voiceDisplayName,
	hasBundledVoiceAvatar,
} from "../src/voices.js";

const MODEL_REV = "4e1e0a3e611c51c0b4ed8174fc10f32a54644303";
const VOICE_REV = "4e1e0a3e611c51c0b4ed8174fc10f32a54644303";

describe("language catalog", () => {
	it("uses English as the fallback language", () => {
		expect(DEFAULT_LANGUAGE_ID).toBe("english");
		expect(getDefaultVoiceForLanguage("unknown")).toBe("alba");
	});

	it("maps locales to supported language ids", () => {
		expect(languageFromLocale("en-US")).toBe("english");
		expect(languageFromLocale("de_DE")).toBe("german");
		expect(languageFromLocale("it")).toBe("italian");
		expect(languageFromLocale("pt-BR")).toBe("portuguese");
		expect(languageFromLocale("es-ES")).toBe("spanish");
		expect(languageFromLocale("fr-FR")).toBe("french");
		expect(languageFromLocale("nl-NL")).toBe("dutch");
		expect(languageFromLocale("ja-JP")).toBe(null);
	});

	it("exposes language defaults and flags", () => {
		expect(getLanguage("german").defaultVoice).toBe("juergen");
		expect(languageFlag("spanish")).toBe("🇪🇸");
	});

	it("builds cache keys from complete pinned asset URLs", () => {
		expect(decodeURIComponent(getModelCacheKey("german"))).toBe(
			`https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/${MODEL_REV}/languages/german/model.safetensors`,
		);
		expect(decodeURIComponent(getTokenizerCacheKey("german"))).toBe(
			`https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/${MODEL_REV}/languages/german/tokenizer.json`,
		);
		expect(decodeURIComponent(getVoiceCacheKey("german", "juergen"))).toBe(
			`https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/${VOICE_REV}/languages/german/embeddings/juergen.safetensors`,
		);
	});

	it("uses upstream Hugging Face URLs by model and revision", () => {
		expect(getModelUrl("german")).toContain(
			`/resolve/${MODEL_REV}/languages/german/model.safetensors`,
		);
		expect(getTokenizerUrl("german")).toContain(
			`/resolve/${MODEL_REV}/languages/german/tokenizer.json`,
		);
		expect(getVoiceUrl("german", "juergen")).toContain(
			`/resolve/${VOICE_REV}/languages/german/embeddings/juergen.safetensors`,
		);
	});

	it("preserves upstream config options including legacy architectures", () => {
		const germanYaml = buildLanguageConfigYaml("german");
		expect(germanYaml).toContain("remove_semicolons: true");
		expect(germanYaml).toContain("num_layers: 6");

		const frenchYaml = buildLanguageConfigYaml("french_24l");
		expect(frenchYaml).toContain("num_layers: 24");
		expect(buildLanguageConfigYaml("english_2026-01")).toContain("insert_bos_before_voice: false");
		expect(getTokenizerUrl("english_2026-01")).toMatch(/\/resolve\/[^/]+\/tokenizer\.json$/);
		expect(getVoiceUrl("english_2026-09_24l", "alba")).toContain("/languages/english_2026-09_24l/embeddings/alba.safetensors");
	});
});

describe("voice catalog", () => {
	it("contains upstream voices and metadata", () => {
		expect(VOICES.length).toBeGreaterThanOrEqual(26);
		expect(getVoice("juergen")).toMatchObject({ lang: "german", gender: "m" });
		expect(getVoice("estelle")).toMatchObject({ lang: "french", gender: "f" });
		expect(getVoice("daan")).toMatchObject({ lang: "dutch", gender: "m" });
	});

	it("formats voice ids and knows bundled avatars", () => {
		expect(voiceDisplayName("bill_boerst")).toBe("Bill Boerst");
		expect(hasBundledVoiceAvatar("alba")).toBe(true);
		expect(hasBundledVoiceAvatar("juergen")).toBe(false);
	});
});
