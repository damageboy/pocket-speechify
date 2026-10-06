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

describe("RemoteTTS paragraph errors", () => {
	function setup() {
		const tts = new RemoteTTS();
		const deliver = chrome.runtime.onMessage.addListener.mock.calls[0][0];
		tts.play([paragraph("One."), paragraph("Two.")], 0, 0, 1.0);
		const { genId, sessionId } = chrome.runtime.sendMessage.mock.calls[0][0];
		chrome.runtime.sendMessage.mockClear();
		return { tts, deliver: msg => deliver({ sessionId, ...msg }), genId };
	}

	it("stops with an error event on fatal errors", () => {
		const { tts, deliver, genId } = setup();
		const onError = vi.fn();
		tts.addEventListener("error", onError);
		deliver({ type: "tts-paragraph-done", genId, error: "Download failed: 404", fatal: true });
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0].detail.error).toBe("Download failed: 404");
		expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
	});

	it("skips to the next paragraph on non-fatal errors", () => {
		const { deliver, genId } = setup();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		deliver({ type: "tts-paragraph-done", genId, error: "bad text" });
		expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "tts-play-paragraph", paragraphText: "Two.", startPlayback: false }),
		);
	});
});

describe("RemoteTTS speech-rate measurement", () => {
	it("reports measured audio and the words spoken from the start sentence", () => {
		const tts = new RemoteTTS();
		const deliver = chrome.runtime.onMessage.addListener.mock.calls[0][0];
		const twoSentences = {
			text: "One two. Three four five.",
			words: [{}, {}, {}, {}, {}],
			sentences: [{ words: [{}, {}] }, { words: [{}, {}, {}] }],
		};
		tts.play([twoSentences], 0, 2, 1.0); // starts at the second sentence
		const { genId, sessionId } = chrome.runtime.sendMessage.mock.calls[0][0];
		const onMeasured = vi.fn();
		tts.addEventListener("measured", onMeasured);

		deliver({ type: "tts-paragraph-done", genId, sessionId, sourceSec: 1.5 });

		expect(onMeasured.mock.calls[0][0].detail).toEqual({ sourceSec: 1.5, words: 3 });
	});
});

it('distinguishes reloaded clients and ignores old completion during first play', () => {
  const old = new RemoteTTS();
  old.play([paragraph()]);
  const previous = chrome.runtime.sendMessage.mock.calls.at(-1)[0];
  const tts = new RemoteTTS();
  const deliver = chrome.runtime.onMessage.addListener.mock.calls.at(-1)[0];
  tts.play([paragraph('First.'), paragraph('Second.')]);
  const current = chrome.runtime.sendMessage.mock.calls.at(-1)[0];
  expect(current.startPlayback).toBe(true);
  expect(current.sessionId).toBeTruthy();
  expect(current.sessionId).not.toBe(previous.sessionId);
  chrome.runtime.sendMessage.mockClear();
  deliver({ ...previous, type: 'tts-paragraph-done', source: undefined, sourceSec: 1 });
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it('ends a superseded client without cancelling its replacement and ignores late events', () => {
  const tts = new RemoteTTS();
  const deliver = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  tts.play([paragraph(), paragraph()]);
  const request = chrome.runtime.sendMessage.mock.calls.at(-1)[0];
  const end = vi.fn();
  tts.addEventListener('end', end);
  chrome.runtime.sendMessage.mockClear();
  deliver({ ...request, source: undefined, type: 'tts-superseded' });
  deliver({ ...request, source: undefined, type: 'tts-paragraph-done', sourceSec: 1 });
  expect(end).toHaveBeenCalledTimes(1);
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it('tags pause/resume/speed/stop with the playback identity and ignores completion after stop', () => {
  const tts = new RemoteTTS();
  const deliver = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  tts.play([paragraph(), paragraph()]);
  const { genId, sessionId } = chrome.runtime.sendMessage.mock.calls.at(-1)[0];
  tts.pause(); tts.resume(); tts.setSpeed(2); tts.stop();
  for (const [msg] of chrome.runtime.sendMessage.mock.calls.slice(1)) {
    expect(msg).toMatchObject({ genId, sessionId });
  }
  chrome.runtime.sendMessage.mockClear();
  deliver({ type: 'tts-paragraph-done', genId, sessionId, sourceSec: 1 });
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it('can create a playback identity on HTTP pages without crypto.randomUUID', () => {
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw new Error('Secure context only'); });
  expect(() => new RemoteTTS()).not.toThrow();
  vi.restoreAllMocks();
});
