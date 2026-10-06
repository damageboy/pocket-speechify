import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Observe the entrypoint's UI contract; extraction, state, RemoteTTS and
// highlighting remain real. Audio messages stand in for the extension host.
const ui = vi.hoisted(() => ({}));
vi.mock('../src/pill-player.js', () => ({
  initPillPlayer: async (shadow, state, actions) => Object.assign(ui, { state, actions }),
}));
vi.mock('../src/side-panels.js', () => ({ initSidePanels() {} }));
vi.mock('wxt/browser', () => ({ get browser() { return globalThis.chrome; } }));

let listeners, cleanup;
const request = () => chrome.runtime.sendMessage.mock.calls.map(([msg]) => msg).findLast(msg => msg.type === 'tts-play-paragraph');
function deliver(type, detail, owner = request()) {
  for (const listener of listeners) listener({ type, detail, sessionId: owner.sessionId, genId: owner.genId });
}
async function refresh() {
  await vi.advanceTimersByTimeAsync(150);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  listeners = [];
  cleanup = null;
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
    storage: { local: { get: async () => ({}) } },
  });
  document.head.replaceChildren();
  document.body.innerHTML = `<main><p id="first">${'First words '.repeat(40)}.</p><p id="second">${'Second words '.repeat(40)}.</p></main>`;
  const { default: content } = await import('../entrypoints/content.js');
  await content.main({ onInvalidated(fn) { cleanup = fn; } });
});

afterEach(() => {
  cleanup?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
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
