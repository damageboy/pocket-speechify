import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Observe the entrypoint's UI contract; panels, extraction, state, RemoteTTS
// and highlighting remain real. Audio messages stand in for the extension host.
const ui = vi.hoisted(() => ({}));
vi.mock('../src/pill-player.js', () => ({
  initPillPlayer: async (shadow, state, actions) => {
    shadow.innerHTML = '<div class="pill-container"></div>';
    Object.assign(ui, { shadow, state, actions });
  },
}));
vi.mock('wxt/browser', () => ({ get browser() { return globalThis.chrome; } }));

let listeners, cleanup;
const request = () => chrome.runtime.sendMessage.mock.calls.map(([msg]) => msg).findLast(msg => msg.type === 'tts-play-paragraph');
function deliver(type, detail, owner = request()) {
  for (const listener of listeners) listener({ type, detail, sessionId: owner.sessionId, genId: owner.genId });
}
async function refresh() {
  await vi.advanceTimersByTimeAsync(150);
}

async function loadPage(url = 'https://example.com/article', lang = '') {
  cleanup?.();
  listeners = [];
  vi.resetModules();
  location.href = url;
  document.head.replaceChildren();
  document.documentElement.lang = lang;
  document.body.innerHTML = `<main><p id="first">${'First words '.repeat(40)}.</p><p id="second">${'Second words '.repeat(40)}.</p></main>`;
  const { default: content } = await import('../entrypoints/content.js');
  await content.main({ onInvalidated(fn) { cleanup = fn; } });
}

beforeEach(async () => {
  vi.useFakeTimers();
  listeners = [];
  cleanup = null;
  const stored = {};
  vi.stubGlobal('CSS', { highlights: new Map() });
  vi.stubGlobal('Highlight', class extends Set { constructor(...ranges) { super(ranges); } });
  vi.stubGlobal('location', { href: 'https://example.com/article' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => '' })));
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: path => path,
      sendMessage: vi.fn(),
      onMessage: { addListener: fn => listeners.push(fn), removeListener: vi.fn() },
    },
    storage: { local: {
      get: vi.fn(async keys => Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(stored[key])]),
      )),
      set: vi.fn(async values => { Object.assign(stored, structuredClone(values)); }),
    } },
  });
  await loadPage();
});

afterEach(() => {
  cleanup?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('restores a chosen model and voice on reload and on another site, including the first playback request', async () => {
  ui.state.dispatch({ panelOpen: 'voice' });
  const select = ui.shadow.querySelector('.language-selector');
  select.value = 'english_2026-09_24l';
  select.dispatchEvent(new Event('change'));
  await refresh();
  [...ui.shadow.querySelectorAll('.voice-item')].find(item => item.querySelector('.voice-name').textContent === 'Vera').click();
  await refresh();

  for (const url of ['https://example.com/article', 'https://another.org/story']) {
    await loadPage(url, 'fr-FR');
    ui.state.dispatch({ panelOpen: 'voice' });
    expect(ui.shadow.querySelector('.language-selector').value).toBe('english_2026-09_24l');
    expect(ui.shadow.querySelector('.voice-item.selected .voice-name').textContent).toBe('Vera');
    ui.actions.play();
    expect(request()).toMatchObject({ language: 'english_2026-09_24l', voiceId: 'vera' });
  }
});

it('persists a model change even without a subsequent voice click', async () => {
  await ui.actions.setLanguage('french_24l');
  await loadPage('https://another.org/story', 'en-US');
  ui.actions.play();
  expect(request()).toMatchObject({ language: 'french_24l', voiceId: 'estelle' });
});

it('restores a speed-only change in the controls and first playback after reload or opening another site', async () => {
  ui.state.dispatch({ panelOpen: 'speed' });
  const slider = ui.shadow.querySelector('.speed-slider');
  slider.value = '1.7';
  slider.dispatchEvent(new Event('input'));
  await refresh();

  for (const url of ['https://example.com/article', 'https://another.org/story']) {
    await loadPage(url);
    ui.state.dispatch({ panelOpen: 'speed' });
    expect(ui.shadow.querySelector('.speed-slider').value).toBe('1.7');
    expect(ui.shadow.querySelector('.speed-value').textContent).toBe('1.7x');
    ui.actions.play();
    expect(request().speed).toBe(1.7);
  }
});

it('preserves saved speed through model and voice changes and persists later speed changes', async () => {
  await ui.actions.setSpeed(0.8);
  await ui.actions.setLanguage('english_2026-09_24l');
  await loadPage();
  expect(ui.state.get().speed).toBe(0.8);
  await ui.actions.setVoice('vera');
  await loadPage();
  ui.actions.play();
  expect(request()).toMatchObject({ language: 'english_2026-09_24l', voiceId: 'vera', speed: 0.8 });

  await ui.actions.setSpeed(2.3);
  await loadPage();
  ui.actions.play();
  expect(request()).toMatchObject({ language: 'english_2026-09_24l', voiceId: 'vera', speed: 2.3 });
});

it('persists an explicit click on the already selected voice without changing the model first', async () => {
  ui.state.dispatch({ panelOpen: 'voice' });
  ui.shadow.querySelector('.voice-item.selected').click();
  await refresh();
  await loadPage('https://another.org/story', 'de-DE');
  ui.actions.play();
  expect(request()).toMatchObject({ language: 'english', voiceId: 'alba' });
});

it('does not save detected defaults just because a page initializes', async () => {
  await loadPage('https://another.org/story', 'fr-FR');
  expect(ui.state.get().selectedLanguage).toBe('french');
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
  ui.actions.play();
  expect(request().speed).toBe(1);
});

it('still changes the model and voice when storage writes fail', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    chrome.storage.local.set.mockRejectedValue(new Error('storage failed'));
    await ui.actions.setLanguage('french_24l');
    [...ui.shadow.querySelectorAll('.voice-item')].find(item => item.querySelector('.voice-name').textContent === 'Marius').click();
    await refresh();
    ui.actions.play();
    expect(request()).toMatchObject({ language: 'french_24l', voiceId: 'marius' });
    expect(warning).toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

it('records only processed engine submissions, not original sentences or stale generations', () => {
  ui.actions.play();
  const owner = request();
  const updates = [];
  ui.state.subscribe((current, prev) => {
    if (current.ttsHistory !== prev.ttsHistory) updates.push(current.ttsHistory);
  });
  deliver('tts-sentence-event', { paragraphIndex: 0, sentenceIndex: 0 });
  expect(ui.state.get().ttsHistory).toEqual([]);
  deliver('tts-processed-text', { paragraphIndex: 0, text: 'Processed engine text.' });
  expect(ui.state.get().ttsHistory).toEqual([{ paragraphIndex: 0, text: 'Processed engine text.' }]);
  expect(updates).toEqual([[{ paragraphIndex: 0, text: 'Processed engine text.' }]]);
  ui.actions.stop();
  deliver('tts-processed-text', { paragraphIndex: 1, text: 'Stale text.' }, owner);
  expect(ui.state.get().ttsHistory).toHaveLength(1);
  expect(updates).toHaveLength(1);
});

it('keeps a paused position and progress when content is inserted before it', async () => {
  ui.actions.play();
  deliver('tts-word', { paragraphIndex: 1, wordIndex: 4 });
  ui.actions.pause();
  const progress = ui.state.get().progress;
  document.querySelector('main').insertAdjacentHTML('afterbegin', '<p>Inserted unrelated paragraph.</p>');
  await refresh();
  expect(ui.state.get()).toMatchObject({ playback: 'paused', currentParagraphIndex: 2, currentWordIndex: 4, progress });
  expect([...CSS.highlights.get('pocket-speechify-word')][0].startContainer.parentElement.id).toBe('second');
});

it.each(['first', 'second'])('cancels when the %s paragraph in the remaining queue changes', async id => {
  ui.actions.play();
  const old = request();
  deliver('tts-word', { paragraphIndex: 0, wordIndex: 1 });
  document.getElementById(id).textContent = 'Changed article text.';
  await refresh();
  expect(ui.state.get().playback).toBe('idle');
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tts-cancel' }));
  deliver('tts-word', { paragraphIndex: 0, wordIndex: 2 }, old);
  expect(CSS.highlights.has('pocket-speechify-word')).toBe(false);
});

it('resumes a paused seek at the same paragraph after insertion', async () => {
  ui.actions.play();
  deliver('tts-word', { paragraphIndex: 0, wordIndex: 1 });
  deliver('tts-sentence-event', { paragraphIndex: 0, sentenceIndex: 0 });
  ui.actions.pause();
  ui.actions.skipForward();
  document.querySelector('main').insertAdjacentHTML('afterbegin', '<p>Inserted unrelated paragraph.</p>');
  await refresh();
  ui.actions.resume();
  expect(request().paragraphText).toBe(document.querySelector('#second').textContent);
});

it('rebinds a paused highlight when a framework replaces text nodes without editing text', async () => {
  ui.actions.play();
  deliver('tts-word', { paragraphIndex: 0, wordIndex: 1 });
  ui.actions.pause();
  const paragraph = document.getElementById('first');
  paragraph.textContent = paragraph.textContent;
  await refresh();
  expect(ui.state.get().playback).toBe('paused');
  const range = [...CSS.highlights.get('pocket-speechify-word')][0];
  expect(range.startContainer).toBe(paragraph.firstChild);
  expect(range.toString()).toBe('words');
});
