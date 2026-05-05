import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteTTS } from "../src/remote-tts.js";

function paragraph(text = "Hallo Welt.") {
	return {
		text,
		words: [{ text: "Hallo" }, { text: "Welt." }],
		sentences: [{ text, words: [{ text: "Hallo" }, { text: "Welt." }] }],
	};
}

beforeEach(() => {
	globalThis.WebAssembly = globalThis.WebAssembly || {};
	globalThis.chrome = {
		runtime: {
			onMessage: {
				addListener: vi.fn(),
				removeListener: vi.fn(),
			},
			sendMessage: vi.fn(),
		},
	};
});

describe("RemoteTTS language routing", () => {
	it("includes selected language in tts-play-paragraph payload", () => {
		const tts = new RemoteTTS();
		tts.setVoice("juergen");
		tts.setLanguage("german");
		tts.play([paragraph()], 0, 0, 1.0);

		expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "tts-play-paragraph",
				language: "german",
				voiceId: "juergen",
			}),
		);
	});

	it("lets play() override the previously configured language", () => {
		const tts = new RemoteTTS();
		tts.setVoice("lola");
		tts.setLanguage("english");
		tts.play([paragraph("Hola mundo.")], 0, 0, 1.0, "spanish");

		expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				language: "spanish",
				voiceId: "lola",
			}),
		);
	});
});
