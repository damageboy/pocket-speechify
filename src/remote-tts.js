// src/remote-tts.js
import { DEFAULT_VOICE_ID } from './voices.js';
import { MockTTS } from './mock-tts.js';

/**
 * Drop-in replacement for MockTTS. Same EventTarget API, same events.
 * Communicates with the service worker → offscreen document → WASM worker pipeline.
 */
export class RemoteTTS extends EventTarget {
  #genId = 0;
  #indexMap = []; // [{ paragraphIndex, sentenceIndex, words, text }]
  #currentEntryIdx = 0;
  #speed = 1.0;
  #voiceId = DEFAULT_VOICE_ID;
  #paragraphs = null;
  #listener = null;
  #fallback = null;

  constructor() {
    super();
    this.#fallback = null;

    // Test WASM availability
    if (typeof WebAssembly === 'undefined') {
      console.warn('[Pocket Speechify] WebAssembly not available, using simulated playback');
      this.#useFallback();
      return;
    }

    this.#listener = (msg) => this.#handleMessage(msg);
    chrome.runtime.onMessage.addListener(this.#listener);
  }

  /**
   * Start playback from a given paragraph/word position.
   * Flattens paragraph structure into per-sentence segments and builds index map.
   * Also estimates totalDurationSec from word counts and dispatches it via 'duration-estimate' event.
   */
  play(paragraphs, fromParagraph = 0, fromWord = 0, speed = 1.0) {
    if (this.#fallback) {
      this.#fallback.play(paragraphs, fromParagraph, fromWord, speed);
      return;
    }
    this.#paragraphs = paragraphs;
    this.#speed = speed;
    this.#genId++;

    // Build index map: ordered list of sentences from the starting position
    this.#indexMap = [];
    for (let pIdx = fromParagraph; pIdx < paragraphs.length; pIdx++) {
      const para = paragraphs[pIdx];
      const startSent = (pIdx === fromParagraph) ? this.#findSentenceForWord(para, fromWord) : 0;
      for (let sIdx = startSent; sIdx < para.sentences.length; sIdx++) {
        this.#indexMap.push({
          paragraphIndex: pIdx,
          sentenceIndex: sIdx,
          words: para.sentences[sIdx].words,
          text: para.sentences[sIdx].text,
        });
      }
    }

    // Estimate total duration from word counts across all sentences
    // Formula per sentence: ceil((numWords / 3 + 2) * 12.5) frames / 12.5 fps
    let totalEstimatedSec = 0;
    for (const entry of this.#indexMap) {
      const frames = Math.ceil((entry.words.length / 3 + 2) * 12.5);
      totalEstimatedSec += frames / 12.5;
    }
    // Adjust for speed
    this.dispatchEvent(new CustomEvent('duration-estimate', {
      detail: { totalDurationSec: totalEstimatedSec / speed },
    }));

    this.#currentEntryIdx = 0;
    this.#sendCurrentSentence();
  }

  pause() {
    if (this.#fallback) {
      this.#fallback.pause();
      return;
    }
    chrome.runtime.sendMessage({ type: 'tts-pause', source: 'content' });
  }

  resume() {
    if (this.#fallback) {
      this.#fallback.resume();
      return;
    }
    chrome.runtime.sendMessage({ type: 'tts-resume', source: 'content' });
  }

  stop() {
    if (this.#fallback) {
      this.#fallback.stop();
      return;
    }
    // Send cancel with the CURRENT genId (the one we want to cancel),
    // then increment so future messages with old genId are ignored.
    chrome.runtime.sendMessage({ type: 'tts-cancel', genId: this.#genId, source: 'content' });
    this.#genId++;
  }

  setSpeed(speed) {
    if (this.#fallback) {
      this.#fallback.setSpeed(speed);
      return;
    }
    this.#speed = speed;
    chrome.runtime.sendMessage({ type: 'tts-set-speed', speed, source: 'content' });
  }

  setVoice(voiceId) {
    this.#voiceId = voiceId;
    // Voice change takes effect on next sentence (per spec)
  }

  getDownloadState() {
    return { model: this._modelState || 'unknown', voices: this._voiceCacheState || new Map() };
  }

  // --- Private ---

  #useFallback() {
    this.#fallback = new MockTTS();
    for (const evtType of ['word', 'sentence', 'paragraph', 'end']) {
      this.#fallback.addEventListener(evtType, (e) => {
        this.dispatchEvent(new CustomEvent(e.type, { detail: e.detail }));
      });
    }
  }

  #findSentenceForWord(para, fromWord) {
    let wordCount = 0;
    for (let sIdx = 0; sIdx < para.sentences.length; sIdx++) {
      wordCount += para.sentences[sIdx].words.length;
      if (fromWord < wordCount) return sIdx;
    }
    return 0;
  }

  #sendCurrentSentence() {
    const entry = this.#indexMap[this.#currentEntryIdx];
    if (!entry) {
      this.dispatchEvent(new CustomEvent('end'));
      return;
    }

    chrome.runtime.sendMessage({
      type: 'tts-play',
      genId: this.#genId,
      text: entry.text,
      voiceId: this.#voiceId, // uses current voiceId — may have changed since play()
      speed: this.#speed,
      source: 'content',
      sentenceMeta: {
        paragraphIndex: entry.paragraphIndex,
        sentenceIndex: entry.sentenceIndex,
        words: entry.words,
      },
    });
  }

  #handleMessage(msg) {
    if (!msg || !msg.type) return;
    // Only process messages relayed by service worker (which strips the source field).
    // Ignore direct broadcasts from service worker or offscreen doc.
    if (msg.source) return;

    switch (msg.type) {
      case 'tts-word': {
        if (msg.genId !== this.#genId) return;
        this.dispatchEvent(new CustomEvent('word', { detail: msg.detail }));
        break;
      }
      case 'tts-sentence-done': {
        if (msg.genId !== this.#genId) return;
        this.#currentEntryIdx++;
        const nextEntry = this.#indexMap[this.#currentEntryIdx];
        if (!nextEntry) {
          this.dispatchEvent(new CustomEvent('end'));
          return;
        }
        const prevEntry = this.#indexMap[this.#currentEntryIdx - 1];
        if (nextEntry.paragraphIndex !== prevEntry.paragraphIndex) {
          this.dispatchEvent(new CustomEvent('paragraph', {
            detail: { paragraphIndex: nextEntry.paragraphIndex },
          }));
        }
        this.dispatchEvent(new CustomEvent('sentence', {
          detail: {
            paragraphIndex: nextEntry.paragraphIndex,
            sentenceIndex: nextEntry.sentenceIndex,
          },
        }));
        this.#sendCurrentSentence();
        break;
      }
      case 'tts-elapsed': {
        if (msg.genId !== this.#genId) return;
        this.dispatchEvent(new CustomEvent('elapsed', { detail: { elapsedSec: msg.elapsedSec } }));
        break;
      }
      case 'download-progress': {
        this.dispatchEvent(new CustomEvent('download-progress', { detail: msg }));
        break;
      }
      case 'download-complete': {
        this.dispatchEvent(new CustomEvent('download-complete', { detail: msg }));
        break;
      }
    }
  }

  destroy() {
    if (this.#listener) {
      chrome.runtime.onMessage.removeListener(this.#listener);
      this.#listener = null;
    }
  }
}
