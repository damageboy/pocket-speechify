(async function initPocketSpeechify() {
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

  const { extractContent } = await import(chrome.runtime.getURL('src/content-extractor.js'));
  const paragraphs = extractContent();
  log.info(`Extracted ${paragraphs.length} paragraphs`);

  // totalDurationSec will be estimated by RemoteTTS on play()

  const { RemoteTTS } = await import(chrome.runtime.getURL('src/remote-tts.js'));
  const tts = new RemoteTTS();

  // Wire TTS events to state updates
  tts.addEventListener('word', (e) => {
    state.dispatch({
      currentParagraphIndex: e.detail.paragraphIndex,
      currentSentenceIndex: e.detail.sentenceIndex,
      currentWordIndex: e.detail.wordIndex,
    });
  });

  tts.addEventListener('elapsed', (e) => {
    state.dispatch({ elapsedSec: e.detail.elapsedSec });
  });

  tts.addEventListener('duration-estimate', (e) => {
    state.dispatch({
      totalDurationSec: e.detail.totalDurationSec,
      elapsedOffsetSec: e.detail.elapsedOffsetSec || 0,
    });
  });

  tts.addEventListener('end', () => {
    log.debug('TTS end — playback complete');
    state.dispatch({
      playback: 'idle',
      currentParagraphIndex: null,
      currentSentenceIndex: null,
      currentWordIndex: null,
      elapsedSec: 0,
    });
  });

  tts.addEventListener('download-progress', (e) => {
    const { asset, voiceId, percent } = e.detail;
    state.dispatch({ downloadProgress: { asset, voiceId, percent } });
    if (asset === 'voice' && voiceId) {
      const voiceCache = { ...state.get().voiceCache, [voiceId]: 'downloading' };
      state.dispatch({ voiceCache });
    }
  });

  tts.addEventListener('download-complete', (e) => {
    const { asset, voiceId } = e.detail;
    if (asset === 'model') {
      state.dispatch({ modelCached: true, downloadProgress: null });
    } else if (asset === 'voice' && voiceId) {
      const voiceCache = { ...state.get().voiceCache, [voiceId]: 'cached' };
      state.dispatch({ voiceCache, downloadProgress: null });
    }
  });

  // Wire voiceId state changes to RemoteTTS
  state.subscribe((current, prev) => {
    if (current.voiceId !== prev.voiceId) {
      tts.setVoice(current.voiceId);
    }
  });

  const actions = {
    play(fromParagraph = 0) {
      if (paragraphs.length === 0) { log.warn('play: no paragraphs'); return; }
      log.debug(`play(fromParagraph=${fromParagraph}), speed=${state.get().speed}`);
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
      tts.resume();
      state.dispatch({ playback: 'playing' });
    },
    stop() {
      log.debug('stop');
      tts.stop();
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
      log.debug(`skipForward from p${pIdx}:s${sIdx}`);
      const para = paragraphs[pIdx];
      let newPIdx = pIdx, newSIdx = sIdx + 1;
      if (newSIdx >= para.sentences.length) {
        newPIdx = pIdx + 1;
        newSIdx = 0;
      }
      if (newPIdx >= paragraphs.length) return;
      // Compute word offset for target sentence within its paragraph
      const fromWord = paragraphs[newPIdx].sentences
        .slice(0, newSIdx)
        .reduce((sum, s) => sum + s.words.length, 0);
      tts.stop();
      state.dispatch({
        currentParagraphIndex: newPIdx,
        currentSentenceIndex: newSIdx,
        currentWordIndex: 0,
      });
      if (playback === 'playing') {
        state.dispatch({ playback: 'playing' });
        tts.play(paragraphs, newPIdx, fromWord, state.get().speed);
      }
    },
    skipBack() {
      const { currentParagraphIndex: pIdx, currentSentenceIndex: sIdx, currentWordIndex: wIdx, playback } = state.get();
      if (pIdx === null) return;
      log.debug(`skipBack from p${pIdx}:s${sIdx}:w${wIdx}`);
      let newPIdx = pIdx, newSIdx = sIdx;
      if (wIdx < 2) {
        newSIdx = sIdx - 1;
        if (newSIdx < 0) {
          newPIdx = pIdx - 1;
          if (newPIdx < 0) { newPIdx = 0; newSIdx = 0; }
          else { newSIdx = paragraphs[newPIdx].sentences.length - 1; }
        }
      }
      // Compute word offset for target sentence within its paragraph
      const fromWord = paragraphs[newPIdx].sentences
        .slice(0, newSIdx)
        .reduce((sum, s) => sum + s.words.length, 0);
      tts.stop();
      state.dispatch({
        currentParagraphIndex: newPIdx,
        currentSentenceIndex: newSIdx,
        currentWordIndex: 0,
      });
      if (playback === 'playing') {
        state.dispatch({ playback: 'playing' });
        tts.play(paragraphs, newPIdx, fromWord, state.get().speed);
      }
    },
    setSpeed(speed) {
      log.debug(`setSpeed(${speed})`);
      tts.setSpeed(speed);
      state.dispatch({ speed });
    },
  };

  const { initPillPlayer } = await import(chrome.runtime.getURL('src/pill-player.js'));
  initPillPlayer(shadow, state, actions, paragraphs);

  const { initSidePanels } = await import(chrome.runtime.getURL('src/side-panels.js'));
  initSidePanels(shadow, state, actions);

  const { initHighlights } = await import(chrome.runtime.getURL('src/highlight.js'));
  initHighlights(state, paragraphs);

  if (paragraphs.length > 0) {
    const { initHoverPlayer } = await import(chrome.runtime.getURL('src/hover-player.js'));
    initHoverPlayer(shadow, state, paragraphs, actions);

    const { initScrollNav } = await import(chrome.runtime.getURL('src/scroll-nav.js'));
    initScrollNav(state, paragraphs);
  }
})();
