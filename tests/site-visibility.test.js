import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ get browser() { return globalThis.chrome; } }));

let background, content, receive, toolbarClick, listeners, cleanup, stored;
const article = `<main><h1>A readable article</h1>${Array.from({ length: 3 }, (_, i) =>
  `<p id="p${i}">Section ${i}. ${'This paragraph explains how reading a longer article can help people understand a subject. '.repeat(16)}</p>`,
).join('')}</main>`;
const shortPage = '<main><p>A short page with too little text to count as an article.</p></main>';
const shadow = () => document.getElementById('pocket-speechify-host').shadowRoot;
const visible = () => shadow().querySelector('.pill-container').style.display !== 'none';
const flush = () => vi.advanceTimersByTimeAsync(200);

async function loadPage(url = 'https://news.example.com/story', html = article) {
  cleanup?.();
  listeners = [];
  location.href = url;
  document.body.innerHTML = html;
  await content.main({ onInvalidated(fn) { cleanup = fn; } });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  cleanup = null;
  listeners = [];
  stored = {};
  vi.stubGlobal('location', { href: 'https://news.example.com/story' });
  vi.stubGlobal('CSS', { highlights: new Map() });
  vi.stubGlobal('Highlight', class extends Set { constructor(...ranges) { super(ranges); } });
  vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => '' })));
  // Only Chrome's cross-context transport/storage and the audio host are faked.
  // Detection, background persistence, content entrypoint and player UI are real.
  vi.stubGlobal('chrome', {
    storage: { local: {
      get: vi.fn(async keys => Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(stored[key])]),
      )),
      set: vi.fn(async values => { Object.assign(stored, structuredClone(values)); }),
    } },
    i18n: { detectLanguage: async () => ({ isReliable: false, languages: [] }) },
    runtime: {
      getURL: path => path,
      getContexts: async () => [],
      onMessage: { addListener: fn => listeners.push(fn), removeListener() {} },
      sendMessage: msg => new Promise(resolve => {
        if (msg.source === 'service-worker') return resolve();
        const pending = receive(msg, { tab: { id: 1 }, frameId: 0, url: location.href }, resolve);
        if (pending !== true) resolve();
      }),
    },
    offscreen: { createDocument: async () => {} },
    tabs: {
      get: async () => ({ id: 1 }),
      sendMessage: async (_id, msg) => { for (const listener of listeners) listener(msg); },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    action: { onClicked: { addListener: fn => { toolbarClick = fn; } } },
  });
  background = (await import('../entrypoints/background.js')).default;
  background.main();
  receive = listeners.pop();
  content = (await import('../entrypoints/content.js')).default;
  await loadPage();
});

afterEach(() => {
  cleanup?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('remembers X across reloads, paths and background restarts without hiding sibling domains', async () => {
  expect(visible()).toBe(true);
  expect(stored).toEqual({}); // Detection must not save a manual preference.
  shadow().querySelector('[aria-label="Turn Off"]').click();
  expect(visible()).toBe(false);
  await flush();
  background.main();
  receive = listeners.pop();
  for (const url of ['https://news.example.com/story', 'http://news.example.com:8080/other']) {
    await loadPage(url);
    expect(visible()).toBe(false);
    document.querySelector('main').insertAdjacentHTML('beforeend', '<p>New content arrives dynamically.</p>');
    await flush();
    expect(visible()).toBe(false);
    document.querySelector('#p0').dispatchEvent(new Event('mouseenter'));
    expect(shadow().querySelector('.hover-player')?.style.display ?? 'none').toBe('none');
  }
  for (const host of ['mail.example.com', 'example.com', 'unrelated.org']) {
    await loadPage(`https://${host}/story`);
    expect(visible()).toBe(true);
  }
});

it('remembers toolbar show on non-articles, with the latest toggle or X taking precedence', async () => {
  await loadPage('https://news.example.com/dashboard', shortPage);
  expect(visible()).toBe(false);
  toolbarClick({ id: 1 });
  expect(visible()).toBe(true);
  await flush();
  await loadPage('https://news.example.com/another-dashboard', shortPage);
  expect(visible()).toBe(true);
  // Showing the pill must not pretend that an unplayable page can be read.
  expect(shadow().querySelector('[aria-label="Play"]').classList.contains('btn-disabled')).toBe(true);
  toolbarClick({ id: 1 });
  await flush();
  await loadPage();
  expect(visible()).toBe(false);
  toolbarClick({ id: 1 });
  await flush();
  document.querySelector('#p0').dispatchEvent(new Event('mouseenter'));
  expect(shadow().querySelector('.hover-player').style.display).toBe('flex');
  shadow().querySelector('[aria-label="Turn Off"]').click();
  expect(shadow().querySelector('.hover-player').style.display).toBe('none');
  document.querySelector('#p0').dispatchEvent(new Event('mouseenter'));
  expect(shadow().querySelector('.hover-player').style.display).toBe('none');
  await flush();
  await loadPage();
  expect(visible()).toBe(false);
});

it('preserves the last rapid choice and independently saves different hosts', async () => {
  let finishFirstWrite;
  chrome.storage.local.set.mockImplementationOnce(values => new Promise(resolve => {
    finishFirstWrite = () => { Object.assign(stored, values); resolve(); };
  }));
  toolbarClick({ id: 1 });
  toolbarClick({ id: 1 });
  await flush();
  finishFirstWrite();
  await flush();
  await loadPage('https://mail.example.com/story');
  shadow().querySelector('[aria-label="Turn Off"]').click();
  await flush();
  await loadPage('https://mail.example.com/story');
  expect(visible()).toBe(false);
  await loadPage('https://news.example.com/dashboard', shortPage);
  expect(visible()).toBe(true);
});

it('keeps manual controls working after a save failure and retries on the next choice', async () => {
  chrome.storage.local.set.mockRejectedValueOnce(new Error('Disk full'));
  shadow().querySelector('[aria-label="Turn Off"]').click();
  await flush();
  expect(visible()).toBe(false);
  toolbarClick({ id: 1 });
  await flush();
  await loadPage('https://news.example.com/dashboard', shortPage);
  expect(visible()).toBe(true);
});
