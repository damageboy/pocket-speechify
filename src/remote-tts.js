// src/remote-tts.js
import { DEFAULT_VOICE_ID } from './voices.js';
import { DEFAULT_LANGUAGE_ID } from './languages.js';

/**
 * EventTarget TTS client (events: word, sentence, measured, download-progress,
 * download-complete, end, error).
 * Communicates with the service worker → offscreen document → WASM worker pipeline.
 *
 * Sends original paragraph text and sentence offsets to the offscreen document.
 * pocket-tts splits the stream internally and returns source-word timestamps.
 */
export class RemoteTTS extends EventTarget {
  // getRandomValues also works on HTTP pages (unlike randomUUID).
  #sessionId = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
  #genId = 0;
  #indexMap = []; // [{ paragraphIndex, startSentenceIndex, para }]
  #currentEntryIdx = 0;
  #speed = 1.0;
  #voiceId = DEFAULT_VOICE_ID;
  #language = DEFAULT_LANGUAGE_ID;
  #listener = null;

  constructor() {
    super();
    this.#listener = (msg) => this.#handleMessage(msg);
    chrome.runtime.onMessage.addListener(this.#listener);
  }

  /**
   * Start playback from a given paragraph/word position.
   * Builds a paragraph-level index map and sends paragraphs one at a time to offscreen.
   * Sentence offsets allow seeking without guessing normalized word indices.
   */
  play(paragraphs, fromParagraph = 0, fromWord = 0, speed = 1.0, language = this.#language) {
    this.#language = language || DEFAULT_LANGUAGE_ID;
    this.#speed = speed;
    this.#genId++;

    // Build index map: one entry per paragraph from the starting position
    this.#indexMap = [];
    for (let pIdx = fromParagraph; pIdx < paragraphs.length; pIdx++) {
      const para = paragraphs[pIdx];
      const startSent = (pIdx === fromParagraph) ? this.#findSentenceForWord(para, fromWord) : 0;
      this.#indexMap.push({ paragraphIndex: pIdx, startSentenceIndex: startSent, para });
    }

    this.#currentEntryIdx = 0;
    this.#sendCurrentParagraph();
  }

  pause() {
    this.#send({ type: 'tts-pause' });
  }

  resume() {
    this.#send({ type: 'tts-resume' });
  }

  stop() {
    this.#send({ type: 'tts-cancel' });
    this.#genId++;
  }

  setSpeed(speed) {
    this.#speed = speed;
    this.#send({ type: 'tts-set-speed', speed });
  }

  setVoice(voiceId) {
    this.#voiceId = voiceId;
  }

  setLanguage(language) {
    this.#language = language || DEFAULT_LANGUAGE_ID;
  }

  // --- Private ---

  #send(msg) {
    chrome.runtime.sendMessage({ ...msg, sessionId: this.#sessionId, genId: this.#genId, source: 'content' });
  }

  #findSentenceForWord(para, fromWord) {
    let wordCount = 0;
    for (let sIdx = 0; sIdx < para.sentences.length; sIdx++) {
      wordCount += para.sentences[sIdx].words.length;
      if (fromWord < wordCount) return sIdx;
    }
    return 0;
  }

  #startWordOffset({ para, startSentenceIndex }) {
    return para.sentences
      .slice(0, startSentenceIndex)
      .reduce((sum, s) => sum + s.words.length, 0);
  }

  #sendCurrentParagraph() {
    const entry = this.#indexMap[this.#currentEntryIdx];
    if (!entry) {
      this.dispatchEvent(new CustomEvent('end'));
      return;
    }
    const { para, paragraphIndex, startSentenceIndex } = entry;
    console.log(`[Pocket Speechify] Sending paragraph ${paragraphIndex} to TTS (startSent=${startSentenceIndex})`);
    const startParaWordOffset = this.#startWordOffset(entry);
    let wordOffset = 0;
    const sentenceWordOffsets = para.sentences.map(sentence => {
      const offset = wordOffset;
      wordOffset += sentence.words.length;
      return offset;
    });

    this.#send({
      type: 'tts-play-paragraph',
      startPlayback: this.#currentEntryIdx === 0,
      paragraphText: para.text,
      paragraphIndex,
      startSentenceIndex,
      sentenceWordOffsets,
      startParaWordOffset,
      language: this.#language,
      voiceId: this.#voiceId,
      speed: this.#speed,
    });
  }

  #handleMessage(msg) {
    if (!msg || !msg.type) return;
    // Only process messages relayed by service worker (which strips the source field).
    if (msg.source) return;
    if (msg.sessionId !== this.#sessionId || msg.genId !== this.#genId) return;

    switch (msg.type) {
      case 'tts-superseded': {
        // Invalidate late events without cancelling the replacement owner's audio.
        this.#genId++;
        this.dispatchEvent(new CustomEvent('end'));
        break;
      }
      case 'tts-word': {
        this.dispatchEvent(new CustomEvent('word', { detail: msg.detail }));
        break;
      }
      case 'tts-sentence-event': {
        // Fired by offscreen for each sentence it starts within a paragraph
        this.dispatchEvent(new CustomEvent('sentence', { detail: msg.detail }));
        break;
      }
      case 'tts-paragraph-done': {
        // Fatal errors (model/voice download or load) would fail again for
        // every remaining paragraph; stop instead of skipping ahead.
        if (msg.error && msg.fatal) {
          this.dispatchEvent(new CustomEvent('error', { detail: { error: msg.error } }));
          return;
        }
        if (msg.error) {
          console.warn(`[Pocket Speechify] Skipping paragraph after TTS error: ${msg.error}`);
        } else {
          // Audio length (at 1x) for the words this paragraph actually spoke.
          const entry = this.#indexMap[this.#currentEntryIdx];
          this.dispatchEvent(new CustomEvent('measured', {
            detail: {
              sourceSec: msg.sourceSec,
              words: entry.para.words.length - this.#startWordOffset(entry),
            },
          }));
        }
        this.#currentEntryIdx++;
        this.#sendCurrentParagraph();
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
