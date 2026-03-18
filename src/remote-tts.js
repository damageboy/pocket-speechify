// src/remote-tts.js
import { DEFAULT_VOICE_ID } from './voices.js';
import { MockTTS } from './mock-tts.js';

/**
 * Drop-in replacement for MockTTS. Same EventTarget API, same events.
 * Communicates with the service worker → offscreen document → WASM worker pipeline.
 *
 * Sends one paragraph at a time to the offscreen document, which normalizes the full
 * paragraph text before splitting into sentences. This ensures abbreviations like "Dr."
 * and numeric patterns are not incorrectly used as sentence boundaries.
 */
export class RemoteTTS extends EventTarget {
  #genId = 0;
  #indexMap = []; // [{ paragraphIndex, startSentenceIndex, para }]
  #currentEntryIdx = 0;
  #speed = 1.0;
  #voiceId = DEFAULT_VOICE_ID;
  #paragraphs = null;
  #listener = null;
  #fallback = null;

  constructor() {
    super();
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
   * Builds a paragraph-level index map and sends paragraphs one at a time to offscreen.
   * The offscreen document normalizes each paragraph before sentence splitting.
   */
  play(paragraphs, fromParagraph = 0, fromWord = 0, speed = 1.0) {
    if (this.#fallback) {
      this.#fallback.play(paragraphs, fromParagraph, fromWord, speed);
      return;
    }
    this.#paragraphs = paragraphs;
    this.#speed = speed;
    this.#genId++;

    // Build index map: one entry per paragraph from the starting position
    this.#indexMap = [];
    for (let pIdx = fromParagraph; pIdx < paragraphs.length; pIdx++) {
      const para = paragraphs[pIdx];
      const startSent = (pIdx === fromParagraph) ? this.#findSentenceForWord(para, fromWord) : 0;
      this.#indexMap.push({ paragraphIndex: pIdx, startSentenceIndex: startSent, para });
    }

    // Estimate full article duration + skipped portion for progress ring
    function estimateSentenceSec(words) {
      return Math.ceil((words.length / 3 + 2) * 12.5) / 12.5;
    }

    let remainingEstimatedSec = 0;
    for (const entry of this.#indexMap) {
      for (const sent of entry.para.sentences) {
        remainingEstimatedSec += estimateSentenceSec(sent.words);
      }
    }

    let skippedSec = 0;
    for (let pIdx = 0; pIdx < fromParagraph; pIdx++) {
      for (const sent of paragraphs[pIdx].sentences) {
        skippedSec += estimateSentenceSec(sent.words);
      }
    }
    if (fromParagraph < paragraphs.length) {
      const startSent = this.#findSentenceForWord(paragraphs[fromParagraph], fromWord);
      for (let sIdx = 0; sIdx < startSent; sIdx++) {
        skippedSec += estimateSentenceSec(paragraphs[fromParagraph].sentences[sIdx].words);
      }
    }

    const fullArticleSec = skippedSec + remainingEstimatedSec;
    this.dispatchEvent(new CustomEvent('duration-estimate', {
      detail: {
        totalDurationSec: fullArticleSec / speed,
        elapsedOffsetSec: skippedSec / speed,
      },
    }));

    this.#currentEntryIdx = 0;
    this.#sendCurrentParagraph();
  }

  pause() {
    if (this.#fallback) { this.#fallback.pause(); return; }
    chrome.runtime.sendMessage({ type: 'tts-pause', source: 'content' });
  }

  resume() {
    if (this.#fallback) { this.#fallback.resume(); return; }
    chrome.runtime.sendMessage({ type: 'tts-resume', source: 'content' });
  }

  stop() {
    if (this.#fallback) { this.#fallback.stop(); return; }
    chrome.runtime.sendMessage({ type: 'tts-cancel', genId: this.#genId, source: 'content' });
    this.#genId++;
  }

  setSpeed(speed) {
    if (this.#fallback) { this.#fallback.setSpeed(speed); return; }
    this.#speed = speed;
    chrome.runtime.sendMessage({ type: 'tts-set-speed', speed, source: 'content' });
  }

  setVoice(voiceId) {
    this.#voiceId = voiceId;
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

  #sendCurrentParagraph() {
    const entry = this.#indexMap[this.#currentEntryIdx];
    if (!entry) {
      this.dispatchEvent(new CustomEvent('end'));
      return;
    }
    const { para, paragraphIndex, startSentenceIndex } = entry;
    console.log(`[Pocket Speechify] Sending paragraph ${paragraphIndex} to TTS (startSent=${startSentenceIndex})`);
    const startParaWordOffset = para.sentences
      .slice(0, startSentenceIndex)
      .reduce((sum, s) => sum + s.words.length, 0);

    chrome.runtime.sendMessage({
      type: 'tts-play-paragraph',
      genId: this.#genId,
      paragraphText: para.text,
      paragraphIndex,
      startSentenceIndex,
      originalSentenceCount: para.sentences.length,
      originalWordCount: para.words.length,
      startParaWordOffset,
      voiceId: this.#voiceId,
      speed: this.#speed,
      source: 'content',
    });
  }

  #handleMessage(msg) {
    if (!msg || !msg.type) return;
    // Only process messages relayed by service worker (which strips the source field).
    if (msg.source) return;

    switch (msg.type) {
      case 'tts-word': {
        if (msg.genId !== this.#genId) return;
        this.dispatchEvent(new CustomEvent('word', { detail: msg.detail }));
        break;
      }
      case 'tts-sentence-event': {
        // Fired by offscreen for each sentence it starts within a paragraph
        if (msg.genId !== this.#genId) return;
        this.dispatchEvent(new CustomEvent('sentence', { detail: msg.detail }));
        break;
      }
      case 'tts-paragraph-done': {
        if (msg.genId !== this.#genId) return;
        this.#currentEntryIdx++;
        const nextEntry = this.#indexMap[this.#currentEntryIdx];
        if (!nextEntry) {
          this.dispatchEvent(new CustomEvent('end'));
          return;
        }
        this.dispatchEvent(new CustomEvent('paragraph', {
          detail: { paragraphIndex: nextEntry.paragraphIndex },
        }));
        this.#sendCurrentParagraph();
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
