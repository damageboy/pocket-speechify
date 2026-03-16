const INITIAL_STATE = {
  playback: 'idle',
  currentParagraphIndex: null,
  currentSentenceIndex: null,
  currentWordIndex: null,
  speed: 1.0,
  voiceId: 'alba',
  panelOpen: null,
  pillExpanded: false,
  totalDurationSec: 0,
  elapsedSec: 0,
  modelCached: false,
  voiceCache: {
    alba: 'uncached',
    marius: 'uncached',
    javert: 'uncached',
    jean: 'uncached',
    fantine: 'uncached',
    cosette: 'uncached',
    eponine: 'uncached',
    azelma: 'uncached',
  },
  downloadProgress: null,
};

export function createState() {
  const bus = new EventTarget();
  let state = { ...INITIAL_STATE };

  function get() {
    return { ...state };
  }

  function dispatch(patch) {
    const prev = state;
    const next = { ...state, ...patch };
    // Skip if nothing changed
    const changed = Object.keys(patch).some(k => next[k] !== prev[k]);
    if (!changed) return;
    state = next;
    bus.dispatchEvent(new CustomEvent('statechange', {
      detail: { current: { ...state }, prev }
    }));
  }

  function subscribe(fn) {
    bus.addEventListener('statechange', (e) => fn(e.detail.current, e.detail.prev));
  }

  function reset() {
    dispatch({ ...INITIAL_STATE });
  }

  return { get, dispatch, subscribe, reset };
}
