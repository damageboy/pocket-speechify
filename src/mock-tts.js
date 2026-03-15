export class MockTTS extends EventTarget {
  #paragraphs = [];
  #pIdx = 0;
  #sIdx = 0;
  #wIdx = 0;
  #timer = null;
  #speed = 1.0;

  play(paragraphs, fromParagraph = 0, fromWord = 0, speed = 1.0) {
    this.stop();
    this.#paragraphs = paragraphs;
    this.#pIdx = fromParagraph;
    this.#sIdx = 0;
    this.#wIdx = 0;
    this.#speed = speed;

    if (fromWord > 0) {
      let remaining = fromWord;
      for (const sent of paragraphs[this.#pIdx].sentences) {
        if (remaining < sent.words.length) {
          this.#wIdx = remaining;
          break;
        }
        remaining -= sent.words.length;
        this.#sIdx++;
      }
    }

    this.#startTimer();
  }

  pause() {
    clearInterval(this.#timer);
    this.#timer = null;
  }

  resume() {
    if (this.#timer) return;
    this.#startTimer();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
    this.#pIdx = 0;
    this.#sIdx = 0;
    this.#wIdx = 0;
  }

  setSpeed(speed) {
    this.#speed = speed;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#startTimer();
    }
  }

  #startTimer() {
    this.#timer = setInterval(() => this.#tick(), 250 / this.#speed);
  }

  #tick() {
    // Advance past any boundary (sentence/paragraph) without consuming a tick.
    // This avoids a 250ms stutter at every boundary.
    while (true) {
      const para = this.#paragraphs[this.#pIdx];
      if (!para) { this.#finish(); return; }

      const sent = para.sentences[this.#sIdx];
      if (!sent) { this.#nextParagraph(); continue; }

      const word = sent.words[this.#wIdx];
      if (!word) { this.#nextSentence(); continue; }

      // Found a valid word — emit and advance
      this.dispatchEvent(new CustomEvent('word', {
        detail: {
          paragraphIndex: this.#pIdx,
          sentenceIndex: this.#sIdx,
          wordIndex: this.#wIdx,
          word: word.text,
        }
      }));

      this.#wIdx++;
      return; // one word per tick
    }
  }

  #nextSentence() {
    const para = this.#paragraphs[this.#pIdx];
    this.#sIdx++;
    this.#wIdx = 0;
    if (this.#sIdx >= para.sentences.length) {
      this.#nextParagraph();
      return;
    }
    this.dispatchEvent(new CustomEvent('sentence', {
      detail: { paragraphIndex: this.#pIdx, sentenceIndex: this.#sIdx }
    }));
  }

  #nextParagraph() {
    this.#pIdx++;
    this.#sIdx = 0;
    this.#wIdx = 0;
    if (this.#pIdx >= this.#paragraphs.length) {
      this.#finish();
      return;
    }
    this.dispatchEvent(new CustomEvent('paragraph', {
      detail: { paragraphIndex: this.#pIdx }
    }));
  }

  #finish() {
    clearInterval(this.#timer);
    this.#timer = null;
    this.dispatchEvent(new CustomEvent('end'));
  }
}
