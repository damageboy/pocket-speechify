(async function initPocketSpeechify() {
  const WORDS_PER_SEC = 4;

  // Load logger first (also exposes __psSetLogLevel / __psGetLogLevel on window)
  const { log } = await import(chrome.runtime.getURL('src/logger.js'));

  if (document.getElementById('pocket-speechify-host')) return;

  const host = document.createElement('div');
  host.id = 'pocket-speechify-host';
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483645; pointer-events: none;';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const cssUrl = chrome.runtime.getURL('css/player.css');
  const cssText = await fetch(cssUrl).then(r => r.text());
  const style = document.createElement('style');
  style.textContent = cssText;
  shadow.appendChild(style);

  const { createState } = await import(chrome.runtime.getURL('src/state.js'));
  const state = createState();

  // Task 3: Content extraction
  const { extractContent } = await import(chrome.runtime.getURL('src/content-extractor.js'));
  const paragraphs = extractContent();
  const totalWords = paragraphs.reduce((sum, p) =>
    sum + p.sentences.reduce((s, sent) => s + sent.words.length, 0), 0);
  const totalDurationSec = totalWords / (state.get().speed * WORDS_PER_SEC);
  state.dispatch({ totalDurationSec });
  log.info(`Extracted ${paragraphs.length} paragraphs, ${totalWords} words, ~${Math.round(totalDurationSec)}s`);

  const { MockTTS } = await import(chrome.runtime.getURL('src/mock-tts.js'));
  const tts = new MockTTS();

  // Wire TTS events to state updates
  let wordsConsumed = 0;
  tts.addEventListener('word', (e) => {
    wordsConsumed++;
    const { speed } = state.get();
    state.dispatch({
      currentParagraphIndex: e.detail.paragraphIndex,
      currentSentenceIndex: e.detail.sentenceIndex,
      currentWordIndex: e.detail.wordIndex,
      elapsedSec: wordsConsumed / (speed * WORDS_PER_SEC),
    });
  });

  tts.addEventListener('end', () => {
    log.debug('TTS end — playback complete');
    wordsConsumed = 0;
    state.dispatch({
      playback: 'idle',
      currentParagraphIndex: null,
      currentSentenceIndex: null,
      currentWordIndex: null,
      elapsedSec: 0,
    });
  });

  // Helper: count total words before a given paragraph+sentence position
  function wordsBefore(endParaIdx, endSentIdx = 0) {
    let total = 0;
    for (let i = 0; i < endParaIdx; i++)
      total += paragraphs[i].sentences.reduce((s, sent) => s + sent.words.length, 0);
    for (let i = 0; i < endSentIdx; i++)
      total += paragraphs[endParaIdx].sentences[i].words.length;
    return total;
  }

  // Actions object bridges UI clicks to TTS + state
  const actions = {
    play(fromParagraph = 0) {
      if (paragraphs.length === 0) { log.warn('play: no paragraphs'); return; }
      log.debug(`play(fromParagraph=${fromParagraph}), speed=${state.get().speed}`);
      wordsConsumed = 0;
      state.dispatch({ playback: 'playing' });
      tts.play(paragraphs, fromParagraph, 0, state.get().speed);
    },
    pause() {
      log.debug('pause');
      state.dispatch({ playback: 'paused' });
      tts.pause();
    },
    resume() {
      log.debug('resume');
      const { currentParagraphIndex: pIdx, currentSentenceIndex: sIdx } = state.get();
      if (pIdx !== null) {
        const fromWord = wordsBefore(pIdx, sIdx) - wordsBefore(pIdx);
        tts.stop();
        tts.play(paragraphs, pIdx, fromWord, state.get().speed);
      } else {
        tts.resume();
      }
      state.dispatch({ playback: 'playing' });
    },
    stop() {
      log.debug('stop');
      tts.stop();
      wordsConsumed = 0;
      state.dispatch({
        playback: 'idle',
        currentParagraphIndex: null,
        currentSentenceIndex: null,
        currentWordIndex: null,
        elapsedSec: 0,
      });
    },
    skipForward() {
      const { currentParagraphIndex: pIdx, currentSentenceIndex: sIdx, playback } = state.get();
      if (pIdx === null) return;
      log.debug(`skipForward from p${pIdx}:s${sIdx}, playback=${playback}`);
      const para = paragraphs[pIdx];
      let newPIdx = pIdx, newSIdx = sIdx + 1;
      if (newSIdx >= para.sentences.length) {
        newPIdx = pIdx + 1;
        newSIdx = 0;
      }
      if (newPIdx >= paragraphs.length) return;
      wordsConsumed = wordsBefore(newPIdx, newSIdx);
      tts.stop();
      if (playback === 'playing') {
        tts.play(paragraphs, newPIdx, wordsConsumed - wordsBefore(newPIdx), state.get().speed);
      }
      state.dispatch({
        currentParagraphIndex: newPIdx,
        currentSentenceIndex: newSIdx,
        currentWordIndex: 0,
        elapsedSec: wordsConsumed / (state.get().speed * WORDS_PER_SEC),
      });
    },
    skipBack() {
      const { currentParagraphIndex: pIdx, currentSentenceIndex: sIdx, currentWordIndex: wIdx, playback } = state.get();
      if (pIdx === null) return;
      log.debug(`skipBack from p${pIdx}:s${sIdx}:w${wIdx}, playback=${playback}`);
      let newPIdx = pIdx, newSIdx = sIdx;
      if (wIdx < 2) {
        newSIdx = sIdx - 1;
        if (newSIdx < 0) {
          newPIdx = pIdx - 1;
          if (newPIdx < 0) { newPIdx = 0; newSIdx = 0; }
          else { newSIdx = paragraphs[newPIdx].sentences.length - 1; }
        }
      }
      wordsConsumed = wordsBefore(newPIdx, newSIdx);
      tts.stop();
      if (playback === 'playing') {
        tts.play(paragraphs, newPIdx, wordsConsumed - wordsBefore(newPIdx), state.get().speed);
      }
      state.dispatch({
        currentParagraphIndex: newPIdx,
        currentSentenceIndex: newSIdx,
        currentWordIndex: 0,
        elapsedSec: wordsConsumed / (state.get().speed * WORDS_PER_SEC),
      });
    },
    setSpeed(speed) {
      log.debug(`setSpeed(${speed})`);
      tts.setSpeed(speed);
      state.dispatch({ speed, totalDurationSec: totalWords / (speed * WORDS_PER_SEC) });
    },
  };

  const { initPillPlayer } = await import(chrome.runtime.getURL('src/pill-player.js'));
  initPillPlayer(shadow, state, actions, paragraphs);

  const { initSidePanels } = await import(chrome.runtime.getURL('src/side-panels.js'));
  initSidePanels(shadow, state, actions);

  const { initHighlights } = await import(chrome.runtime.getURL('src/highlight.js'));
  initHighlights(state, paragraphs);

  // Only initialize hover player and scroll nav when there is content to play
  if (paragraphs.length > 0) {
    const { initHoverPlayer } = await import(chrome.runtime.getURL('src/hover-player.js'));
    initHoverPlayer(shadow, state, paragraphs, actions);

    const { initScrollNav } = await import(chrome.runtime.getURL('src/scroll-nav.js'));
    initScrollNav(state, paragraphs);
  }
})();
