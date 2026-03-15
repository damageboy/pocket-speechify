(async function initPocketSpeechify() {
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
  const totalDurationSec = totalWords / (state.get().speed * 4);
  state.dispatch({ totalDurationSec });
  console.log(`[Pocket Speechify] Extracted ${paragraphs.length} paragraphs, ${totalWords} words, ~${Math.round(totalDurationSec)}s`);

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
      elapsedSec: wordsConsumed / (speed * 4),
    });
  });

  tts.addEventListener('end', () => {
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
      wordsConsumed = 0;
      state.dispatch({ playback: 'playing' });
      tts.play(paragraphs, fromParagraph, 0, state.get().speed);
    },
    pause() {
      state.dispatch({ playback: 'paused' });
      tts.pause();
    },
    resume() {
      state.dispatch({ playback: 'playing' });
      tts.resume();
    },
    stop() {
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
      const { currentParagraphIndex: pIdx, currentSentenceIndex: sIdx } = state.get();
      if (pIdx === null) return;
      const para = paragraphs[pIdx];
      let newPIdx = pIdx, newSIdx = sIdx + 1;
      if (newSIdx >= para.sentences.length) {
        newPIdx = pIdx + 1;
        newSIdx = 0;
      }
      if (newPIdx >= paragraphs.length) return;
      wordsConsumed = wordsBefore(newPIdx, newSIdx);
      tts.stop();
      tts.play(paragraphs, newPIdx, wordsConsumed - wordsBefore(newPIdx), state.get().speed);
      state.dispatch({
        currentParagraphIndex: newPIdx,
        currentSentenceIndex: newSIdx,
        currentWordIndex: 0,
        elapsedSec: wordsConsumed / (state.get().speed * 4),
      });
    },
    skipBack() {
      const { currentParagraphIndex: pIdx, currentSentenceIndex: sIdx, currentWordIndex: wIdx } = state.get();
      if (pIdx === null) return;
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
      tts.play(paragraphs, newPIdx, wordsConsumed - wordsBefore(newPIdx), state.get().speed);
      state.dispatch({
        currentParagraphIndex: newPIdx,
        currentSentenceIndex: newSIdx,
        currentWordIndex: 0,
        elapsedSec: wordsConsumed / (state.get().speed * 4),
      });
    },
    setSpeed(speed) {
      tts.setSpeed(speed);
      const tw = paragraphs.reduce((sum, p) =>
        sum + p.sentences.reduce((s, sent) => s + sent.words.length, 0), 0);
      state.dispatch({ speed, totalDurationSec: tw / (speed * 4) });
    },
  };

  const { initPillPlayer } = await import(chrome.runtime.getURL('src/pill-player.js'));
  initPillPlayer(shadow, state, actions, paragraphs);

  const { initSidePanels } = await import(chrome.runtime.getURL('src/side-panels.js'));
  initSidePanels(shadow, state, actions);
})();
