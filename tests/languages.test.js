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

const MODEL_REV = "d29db7978e464fb90cb3359ee0c69a273b9142cc";
const VOICE_REV = "e041936c75475d350b405bc870bcf7c22da4e9e6";

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
		expect(languageFromLocale("fr-FR")).toBe("french_24l");
		expect(languageFromLocale("nl-NL")).toBe(null);
	});

	it("exposes language defaults and flags", () => {
		expect(getLanguage("german").defaultVoice).toBe("juergen");
		expect(languageFlag("spanish")).toBe("🇪🇸");
	});

	it("builds v2 cache keys by language", () => {
		expect(getModelCacheKey("german")).toBe(
			"languages/german/model.safetensors",
		);
		expect(getTokenizerCacheKey("german")).toBe(
			"languages/german/tokenizer.model",
		);
		expect(getVoiceCacheKey("german", "juergen")).toBe(
			"languages/german/embeddings/juergen.safetensors",
		);
	});

	it("builds v2 Hugging Face URLs by language and revision", () => {
		expect(getModelUrl("german")).toContain(
			`/resolve/${MODEL_REV}/languages/german/model.safetensors`,
		);
		expect(getTokenizerUrl("german")).toContain(
			`/resolve/${MODEL_REV}/languages/german/tokenizer.model`,
		);
		expect(getVoiceUrl("german", "juergen")).toContain(
			`/resolve/${VOICE_REV}/languages/german/embeddings/juergen.safetensors`,
		);
	});

	it("generates language-specific config yaml", () => {
		const germanYaml = buildLanguageConfigYaml("german");
		expect(germanYaml).toContain("remove_semicolons: true");
		expect(germanYaml).toContain("num_layers: 6");

		const frenchYaml = buildLanguageConfigYaml("french_24l");
		expect(frenchYaml).toContain("model_recommended_frames_after_eos: 8");
		expect(frenchYaml).toContain("num_layers: 24");
	});
});

describe("voice catalog", () => {
	it("contains v2 voices and metadata", () => {
		expect(VOICES.length).toBeGreaterThanOrEqual(26);
		expect(getVoice("juergen")).toMatchObject({ lang: "german", gender: "m" });
		expect(getVoice("estelle")).toMatchObject({ lang: "french", gender: "f" });
	});

	it("formats voice ids and knows bundled avatars", () => {
		expect(voiceDisplayName("bill_boerst")).toBe("Bill Boerst");
		expect(hasBundledVoiceAvatar("alba")).toBe(true);
		expect(hasBundledVoiceAvatar("juergen")).toBe(false);
	});
});
