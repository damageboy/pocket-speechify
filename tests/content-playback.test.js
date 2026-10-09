import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSpeechProfileStore } from '../src/speech-preferences.js';

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
  const profiles = createSpeechProfileStore(chrome.storage.local);
  chrome.runtime.sendMessage.mockImplementation(async msg => {
    if (msg.type === 'speech-detect-language') return { isReliable: false, languages: [] };
    if (msg.type === 'speech-profile-get') return profiles.get(msg.language);
    if (msg.type === 'speech-profile-update') return profiles.update(msg.language, msg.patch);
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

it('restores an English profile on English pages without overriding French detection', async () => {
  ui.state.dispatch({ panelOpen: 'voice' });
  const select = ui.shadow.querySelector('.model-selector');
  select.value = 'english_2026-09_24l';
  select.dispatchEvent(new Event('change'));
  await refresh();
  [...ui.shadow.querySelectorAll('.voice-item')].find(item => item.querySelector('.voice-name').textContent === 'Vera').click();
  await refresh();

  for (const url of ['https://example.com/article', 'https://another.org/story']) {
    await loadPage(url, 'en-US');
    ui.state.dispatch({ panelOpen: 'voice' });
    expect(ui.shadow.querySelector('.language-selector').value).toBe('english');
    expect(ui.shadow.querySelector('.model-selector').value).toBe('english_2026-09_24l');
    expect(ui.shadow.querySelector('.voice-item.selected .voice-name').textContent).toBe('Vera');
    await ui.actions.play();
    expect(request()).toMatchObject({ language: 'english_2026-09_24l', voiceId: 'vera' });
  }
  await loadPage('https://another.org/french', 'fr-FR');
  await ui.actions.play();
  expect(request()).toMatchObject({ language: 'french', voiceId: 'estelle', speed: 1 });
});

it('persists a model change even without a subsequent voice click', async () => {
  await ui.actions.setLanguage('french');
  await ui.actions.setModel('french_24l');
  await loadPage('https://another.org/story', 'fr-FR');
  await ui.actions.play();
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
    await ui.actions.play();
    expect(request().speed).toBe(1.7);
  }
});

it('preserves saved speed through model and voice changes and persists later speed changes', async () => {
  await ui.actions.setSpeed(0.8);
  await ui.actions.setModel('english_2026-09_24l');
  await loadPage();
  expect(ui.state.get().speed).toBe(0.8);
  await ui.actions.setVoice('vera');
  await loadPage();
  await ui.actions.play();
  expect(request()).toMatchObject({ language: 'english_2026-09_24l', voiceId: 'vera', speed: 0.8 });

  await ui.actions.setSpeed(2.3);
  await loadPage();
  await ui.actions.play();
  expect(request()).toMatchObject({ language: 'english_2026-09_24l', voiceId: 'vera', speed: 2.3 });
});

it('does not let an explicit default voice click force the language of other pages', async () => {
  ui.state.dispatch({ panelOpen: 'voice' });
  ui.shadow.querySelector('.voice-item.selected').click();
  await refresh();
  await loadPage('https://another.org/story', 'de-DE');
  await ui.actions.play();
  expect(request()).toMatchObject({ language: 'german', voiceId: 'juergen' });
});

it('does not save detected defaults just because a page initializes', async () => {
  await loadPage('https://another.org/story', 'fr-FR');
  expect(ui.state.get().selectedModelId).toBe('french');
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
  await ui.actions.play();
  expect(request().speed).toBe(1);
});

it('still changes the model and voice when storage writes fail', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    chrome.storage.local.set.mockRejectedValue(new Error('storage failed'));
    await ui.actions.setLanguage('french');
    await ui.actions.setModel('french_24l');
    [...ui.shadow.querySelectorAll('.voice-item')].find(item => item.querySelector('.voice-name').textContent === 'Marius').click();
    await refresh();
    await ui.actions.play();
    expect(request()).toMatchObject({ language: 'french_24l', voiceId: 'marius' });
    expect(warning).toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

it('records only processed engine submissions, not original sentences or stale generations', async () => {
  await ui.actions.play();
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
  await ui.actions.play();
  deliver('tts-word', { paragraphIndex: 1, wordIndex: 4 });
  ui.actions.pause();
  const progress = ui.state.get().progress;
  document.querySelector('main').insertAdjacentHTML('afterbegin', '<p>Inserted unrelated paragraph.</p>');
  await refresh();
  expect(ui.state.get()).toMatchObject({ playback: 'paused', currentParagraphIndex: 2, currentWordIndex: 4, progress });
  expect([...CSS.highlights.get('pocket-speechify-word')][0].startContainer.parentElement.id).toBe('second');
});

it.each(['first', 'second'])('cancels when the %s paragraph in the remaining queue changes', async id => {
  await ui.actions.play();
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
  await ui.actions.play();
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
  await ui.actions.play();
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

it('restores independent language profiles after switches, reloads and new pages', async () => {
  await ui.actions.setModel('english_2026-09');
  await ui.actions.setVoice('vera');
  await ui.actions.setSpeed(1.7);
  await ui.actions.setLanguage('french');
  expect(ui.state.get()).toMatchObject({ selectedModelId: 'french', voiceId: 'estelle', speed: 1 });
  await ui.actions.setModel('french_24l');
  await ui.actions.setVoice('marius');
  await ui.actions.setSpeed(0.8);
  await ui.actions.setLanguage('english');
  expect(ui.state.get()).toMatchObject({ selectedModelId: 'english_2026-09', voiceId: 'vera', speed: 1.7 });
  await ui.actions.setLanguage('french');
  await ui.actions.setSpeed(1.2);
  await ui.actions.play();
  expect(request()).toMatchObject({ language: 'french_24l', voiceId: 'marius', speed: 1.2 });
  await loadPage('https://another.org/en', 'en');
  await ui.actions.play();
  expect(request()).toMatchObject({ language: 'english_2026-09', voiceId: 'vera', speed: 1.7 });
  await loadPage('https://another.org/fr', 'fr');
  await ui.actions.play();
  expect(request()).toMatchObject({ language: 'french_24l', voiceId: 'marius', speed: 1.2 });
});

it('ignores stale detection when a manual language choice supersedes playback preparation', async () => {
  let finish;
  chrome.runtime.sendMessage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const playing = ui.actions.play();
  await Promise.resolve();
  await ui.actions.setLanguage('german');
  finish({ isReliable: true, languages: [{ language: 'fr', percentage: 100 }] });
  await playing;
  expect(ui.state.get().activeLanguage).toBe('german');
  expect(request()).toBeUndefined();
});

it('stop cancels a pending playback start', async () => {
  let finish;
  chrome.runtime.sendMessage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const playing = ui.actions.play();
  await Promise.resolve();
  ui.actions.stop();
  finish({ isReliable: false, languages: [] });
  await playing;
  expect(request()).toBeUndefined();
});

it('reads same-language changes from another tab on next playback, not during playback', async () => {
  await ui.actions.play();
  await chrome.runtime.sendMessage({ type: 'speech-profile-update', language: 'english', patch: { voiceId: 'vera', speed: 1.9 } });
  expect(ui.state.get().speed).toBe(1);
  ui.actions.stop();
  await ui.actions.play();
  expect(request()).toMatchObject({ language: 'english', voiceId: 'vera', speed: 1.9 });
});

it('does not start changed content using a stale detection result', async () => {
  let finish;
  chrome.runtime.sendMessage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const playing = ui.actions.play();
  document.getElementById('first').textContent = 'Un nouvel article français. '.repeat(40);
  await refresh();
  finish({ isReliable: true, languages: [{ language: 'en', percentage: 100 }] });
  await playing;
  expect(request()).toBeUndefined();
});

it('keeps the latest manual language when earlier profile loading finishes late', async () => {
  const send = chrome.runtime.sendMessage.getMockImplementation();
  let finish;
  chrome.runtime.sendMessage.mockImplementation(msg => msg.type === 'speech-profile-get' && msg.language === 'french'
    ? new Promise(resolve => { finish = resolve; }) : send(msg));
  const french = ui.actions.setLanguage('french');
  await Promise.resolve();
  await ui.actions.setLanguage('german');
  finish({ modelId: 'french_24l', voiceId: 'marius', speed: 0.8 });
  await french;
  expect(ui.state.get()).toMatchObject({ activeLanguage: 'german', selectedModelId: 'german', voiceId: 'juergen', speed: 1, speechSettingsLoading: false });
});

it('scopes download events without an explicit model to the selected model', async () => {
  await ui.actions.setModel('english_2026-09');
  await ui.actions.play();
  const { sessionId, genId } = request();
  for (const listener of listeners) listener({ type: 'download-progress', asset: 'voice', voiceId: 'vera', percent: 50, sessionId, genId });
  expect(ui.state.get().voiceCache['english_2026-09:vera']).toBe('downloading');
  for (const listener of listeners) listener({ type: 'download-complete', asset: 'voice', voiceId: 'vera', sessionId, genId });
  expect(ui.state.get().voiceCache['english_2026-09:vera']).toBe('cached');
});
