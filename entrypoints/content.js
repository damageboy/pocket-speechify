import { log } from '../src/logger.js';
import { createState } from '../src/state.js';
import { extractContent } from '../src/content-extractor.js';
import { RemoteTTS } from '../src/remote-tts.js';
import { initPillPlayer } from '../src/pill-player.js';
import { initSidePanels } from '../src/side-panels.js';
import { initHighlights } from '../src/highlight.js';
import { initHoverPlayer } from '../src/hover-player.js';
import { initScrollNav } from '../src/scroll-nav.js';
import { resolvePageLanguage, saveLanguageOverride } from '../src/language-detection.js';
import { getDefaultVoiceForLanguage } from '../src/languages.js';

function wordOffsetForSentence(paragraphs, pIdx, sIdx) {
  return paragraphs[pIdx].sentences
    .slice(0, sIdx)
    .reduce((sum, s) => sum + s.words.length, 0);
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    if (document.getElementById('pocket-speechify-host')) return;

    const host = document.createElement('div');
    host.id = 'pocket-speechify-host';
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483645; pointer-events: none;';
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });

    const cssUrl = browser.runtime.getURL('css/player.css');
    const cssText = await fetch(cssUrl).then(r => r.text());
    const style = document.createElement('style');
    style.textContent = cssText;
    shadow.appendChild(style);

    const languageResolution = await resolvePageLanguage(new URL(location.href), document);
    console.log(`[Pocket Speechify] Language resolved: ${languageResolution.selectedLanguage} (${languageResolution.languageSource})`);
    const state = createState({
      selectedLanguage: languageResolution.selectedLanguage,
      detectedLanguage: languageResolution.detectedLanguage,
      languageSource: languageResolution.languageSource,
      siteKey: languageResolution.siteKey,
    });

    const paragraphs = extractContent();
    log.info(`Extracted ${paragraphs.length} paragraphs`);

    /** @type {{ text: string, paragraphIndex: number, sentenceIndex: number }[]} */
    const ttsHistory = [];

    // totalDurationSec will be estimated by RemoteTTS on play()

    const tts = new RemoteTTS();
    tts.setLanguage(state.get().selectedLanguage);
    tts.setVoice(state.get().voiceId);

    // Wire TTS events to state updates
    tts.addEventListener('word', (e) => {
      state.dispatch({
        currentParagraphIndex: e.detail.paragraphIndex,
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
      const { asset, voiceId, language, percent } = e.detail;
      const cacheLanguage = language || state.get().selectedLanguage;
      state.dispatch({ downloadProgress: { asset, voiceId, language: cacheLanguage, percent } });
      if (asset === 'voice' && voiceId) {
        const key = state.voiceCacheKey(cacheLanguage, voiceId);
        const voiceCache = { ...state.get().voiceCache, [key]: 'downloading' };
        state.dispatch({ voiceCache });
      }
    });

    tts.addEventListener('download-complete', (e) => {
      const { asset, voiceId, language } = e.detail;
      const cacheLanguage = language || state.get().selectedLanguage;
      if (asset === 'voice' && voiceId) {
        const key = state.voiceCacheKey(cacheLanguage, voiceId);
        const voiceCache = { ...state.get().voiceCache, [key]: 'cached' };
        state.dispatch({ voiceCache, downloadProgress: null });
      } else {
        state.dispatch({
          ...(asset === 'model' ? { modelCached: true } : {}),
          downloadProgress: null,
        });
      }
    });

    tts.addEventListener('sentence', (e) => {
      const { paragraphIndex, sentenceIndex, text } = e.detail;
      state.dispatch({ currentSentenceIndex: sentenceIndex });
      ttsHistory.push({
        text: text || paragraphs[paragraphIndex]?.sentences[sentenceIndex]?.text || '',
        paragraphIndex,
        sentenceIndex,
      });
    });

    // Wire language and voiceId state changes to RemoteTTS
    state.subscribe((current, prev) => {
      if (current.voiceId !== prev.voiceId) {
        tts.setVoice(current.voiceId);
      }
      if (current.selectedLanguage !== prev.selectedLanguage) {
        tts.setLanguage(current.selectedLanguage);
      }
    });

    const actions = {
      play(fromParagraph = 0) {
        if (paragraphs.length === 0) { log.warn('play: no paragraphs'); return; }
        log.debug(`play(fromParagraph=${fromParagraph}), speed=${state.get().speed}`);
        state.dispatch({ playback: 'playing' });
        tts.play(paragraphs, fromParagraph, 0, state.get().speed, state.get().selectedLanguage);
        ttsHistory.push({
          text: paragraphs[fromParagraph].sentences[0].text,
          paragraphIndex: fromParagraph,
          sentenceIndex: 0,
        });
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
        const fromWord = wordOffsetForSentence(paragraphs, newPIdx, newSIdx);
        tts.stop();
        state.dispatch({
          currentParagraphIndex: newPIdx,
          currentSentenceIndex: newSIdx,
          currentWordIndex: fromWord,
        });
        if (playback === 'playing') {
          state.dispatch({ playback: 'playing' });
          ttsHistory.push({
            text: paragraphs[newPIdx].sentences[newSIdx].text,
            paragraphIndex: newPIdx,
            sentenceIndex: newSIdx,
          });
          tts.play(paragraphs, newPIdx, fromWord, state.get().speed, state.get().selectedLanguage);
        }
      },
      skipBack() {
        const { currentParagraphIndex: pIdx, currentSentenceIndex: sIdx, currentWordIndex: wIdx, playback } = state.get();
        if (pIdx === null) return;
        log.debug(`skipBack from p${pIdx}:s${sIdx}:w${wIdx}`);
        let newPIdx = pIdx, newSIdx = sIdx;
        const sentenceStartWordIdx = wordOffsetForSentence(paragraphs, pIdx, sIdx);
        if (wIdx - sentenceStartWordIdx < 2) {
          newSIdx = sIdx - 1;
          if (newSIdx < 0) {
            newPIdx = pIdx - 1;
            if (newPIdx < 0) { newPIdx = 0; newSIdx = 0; }
            else { newSIdx = paragraphs[newPIdx].sentences.length - 1; }
          }
        }
        const fromWord = wordOffsetForSentence(paragraphs, newPIdx, newSIdx);
        tts.stop();
        state.dispatch({
          currentParagraphIndex: newPIdx,
          currentSentenceIndex: newSIdx,
          currentWordIndex: fromWord,
        });
        if (playback === 'playing') {
          state.dispatch({ playback: 'playing' });
          ttsHistory.push({
            text: paragraphs[newPIdx].sentences[newSIdx].text,
            paragraphIndex: newPIdx,
            sentenceIndex: newSIdx,
          });
          tts.play(paragraphs, newPIdx, fromWord, state.get().speed, state.get().selectedLanguage);
        }
      },
      setSpeed(speed) {
        log.debug(`setSpeed(${speed})`);
        tts.setSpeed(speed);
        state.dispatch({ speed });
      },
      async setLanguage(languageId) {
        console.log(`[Pocket Speechify] Language ${languageId} triggered`);
        const voiceId = getDefaultVoiceForLanguage(languageId);
        await saveLanguageOverride(state.get().siteKey, languageId);
        tts.stop();
        tts.setLanguage(languageId);
        tts.setVoice(voiceId);
        state.dispatch({
          selectedLanguage: languageId,
          languageSource: 'override',
          voiceId,
          playback: 'idle',
          currentParagraphIndex: null,
          currentSentenceIndex: null,
          currentWordIndex: null,
          elapsedSec: 0,
          panelOpen: 'voice',
        });
      },
    };

    await initPillPlayer(shadow, state, actions, paragraphs, ttsHistory);

    // Toolbar button: toggle pill visibility
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type !== 'toggle-pill') return;
      console.log('[Pocket Speechify] toolbar button clicked, toggling pill');
      const container = shadow.querySelector('.pill-container');
      if (!container) return;
      const isHidden = container.style.display === 'none';
      container.style.display = isHidden ? '' : 'none';
      console.log(`[Pocket Speechify] pill toggled, display: ${container.style.display || 'visible'}`);
    });

    initSidePanels(shadow, state, actions);

    initHighlights(state, paragraphs);

    if (paragraphs.length > 0) {
      initHoverPlayer(shadow, state, paragraphs, actions);

      initScrollNav(state, paragraphs);
    }
  },
});
