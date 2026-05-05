import { describe, expect, it } from "vitest";
import { getTTSLoadPlan } from "../src/tts-load-policy.js";

describe("getTTSLoadPlan", () => {
	it("loads model and voice when no worker exists", () => {
		expect(
			getTTSLoadPlan({
				hasWorker: false,
				currentLoadedLanguage: null,
				currentLoadedVoiceId: null,
				language: "english",
				voiceId: "alba",
			}),
		).toEqual({ loadModel: true, loadVoice: true });
	});

	it("loads only voice for same language with a different voice", () => {
		expect(
			getTTSLoadPlan({
				hasWorker: true,
				currentLoadedLanguage: "english",
				currentLoadedVoiceId: "alba",
				language: "english",
				voiceId: "sarah",
			}),
		).toEqual({ loadModel: false, loadVoice: true });
	});

	it("does not load model or voice for same language and same voice", () => {
		expect(
			getTTSLoadPlan({
				hasWorker: true,
				currentLoadedLanguage: "english",
				currentLoadedVoiceId: "alba",
				language: "english",
				voiceId: "alba",
			}),
		).toEqual({ loadModel: false, loadVoice: false });
	});

	it("loads model and voice when language changes", () => {
		expect(
			getTTSLoadPlan({
				hasWorker: true,
				currentLoadedLanguage: "english",
				currentLoadedVoiceId: "alba",
				language: "german",
				voiceId: "juergen",
			}),
		).toEqual({ loadModel: true, loadVoice: true });
	});
});
