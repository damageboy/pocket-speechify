import { beforeEach, it, expect, vi } from 'vitest';
import { DEFAULT_TEXT_RULES, TEXT_RULES_KEY } from '../src/text-rules.js';

let receive;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('chrome', {
    storage: { local: { get: vi.fn(async () => ({})) } },
    runtime: {
      onMessage: { addListener: fn => { receive = fn; } },
      getContexts: vi.fn(async () => [{}]),
      sendMessage: vi.fn(async () => {}),
    },
    offscreen: { createDocument: vi.fn(async () => {}) },
    tabs: { sendMessage: vi.fn(async () => {}) },
    action: { onClicked: { addListener() {} } },
  });
  const { default: background } = await import('../entrypoints/background.js');
  background.main();
});

it('attaches defaults, current saved rules, and an intentionally empty list to paragraph requests', async () => {
  const saved = [{ name: 'Expand', pattern: 'TTS', flags: 'g', replacement: 'text to speech', enabled: true }];
  chrome.storage.local.get.mockResolvedValueOnce({})
    .mockResolvedValueOnce({ [TEXT_RULES_KEY]: saved })
    .mockResolvedValueOnce({ [TEXT_RULES_KEY]: [] });
  for (let paragraphIndex = 0; paragraphIndex < 3; paragraphIndex++) {
    receive({ type: 'tts-play-paragraph', sessionId: 'A', genId: 2, paragraphIndex }, { tab: { id: 1 } });
  }
  for (const type of ['tts-pause', 'tts-resume', 'tts-set-speed', 'tts-cancel']) {
    receive({ type, sessionId: 'A', genId: 2 }, { tab: { id: 1 } });
  }
  await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(7));
  expect(chrome.runtime.sendMessage.mock.calls.slice(0, 3).map(([msg]) => msg.textRules))
    .toEqual([DEFAULT_TEXT_RULES, saved, []]);
  expect(chrome.storage.local.get).toHaveBeenCalledTimes(3);
  expect(chrome.storage.local.get).toHaveBeenCalledWith(TEXT_RULES_KEY);
  expect(chrome.runtime.sendMessage.mock.calls.slice(3).every(([msg]) => !('textRules' in msg))).toBe(true);
});

it('preserves play/pause/cancel arrival order while reading rules', async () => {
  let loaded;
  chrome.storage.local.get.mockReturnValueOnce(new Promise(resolve => { loaded = resolve; }));
  for (const type of ['tts-play-paragraph', 'tts-pause', 'tts-cancel']) {
    receive({ type, sessionId: 'A', genId: 1 }, { tab: { id: 1 } });
  }
  await vi.waitFor(() => expect(chrome.storage.local.get).toHaveBeenCalled());
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  loaded({});
  await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(3));
  expect(chrome.runtime.sendMessage.mock.calls.map(([msg]) => msg.type))
    .toEqual(['tts-play-paragraph', 'tts-pause', 'tts-cancel']);
});

it('reports a rules read failure to its owner and continues forwarding the next request', async () => {
  chrome.storage.local.get.mockRejectedValueOnce(new Error('rules unavailable'));
  receive({ type: 'tts-play-paragraph', sessionId: 'A', genId: 2 }, { tab: { id: 1 } });
  receive({ type: 'tts-play-paragraph', sessionId: 'B', genId: 3 }, { tab: { id: 4 } });
  await vi.waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalled());
  expect(chrome.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(1, {
    type: 'tts-paragraph-done', sessionId: 'A', genId: 2, error: 'Error: rules unavailable', fatal: true,
  });
  await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
    type: 'tts-play-paragraph', sessionId: 'B', genId: 3, tabId: 4,
    source: 'service-worker', textRules: DEFAULT_TEXT_RULES,
  }));
});

it('routes original ownership while another tab is awaiting offscreen readiness', async () => {
  chrome.runtime.getContexts.mockReturnValue(new Promise(() => {}));
  receive({ type: 'tts-play-paragraph', genId: 1, sessionId: 'A' }, { tab: { id: 1 } });
  receive({ type: 'tts-play-paragraph', genId: 1, sessionId: 'B' }, { tab: { id: 2 } });
  receive({ source: 'offscreen', type: 'tts-paragraph-done', tabId: 1, sessionId: 'A', genId: 1 }, {});
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ sessionId: 'A' }));
});

it('routes events after a service worker restart without a previous play message', () => {
  receive({ source: 'offscreen', type: 'tts-superseded', tabId: 4, sessionId: 'old', genId: 1 }, {});
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(4, { type: 'tts-superseded', sessionId: 'old', genId: 1, tabId: 4 });
});

it('routes processed engine text only to its owner and strips the offscreen source', () => {
  receive({ source: 'offscreen', type: 'tts-processed-text', tabId: 4, sessionId: 'A', genId: 2,
    detail: { paragraphIndex: 3, text: 'Doctor Ada.' } }, {});
  expect(chrome.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(4, {
    type: 'tts-processed-text', tabId: 4, sessionId: 'A', genId: 2,
    detail: { paragraphIndex: 3, text: 'Doctor Ada.' },
  });
});

it('preserves play/pause/cancel arrival order across getContexts delays', async () => {
  let ready;
  chrome.runtime.getContexts.mockImplementationOnce(() => new Promise(resolve => { ready = resolve; }));
  for (const type of ['tts-play-paragraph', 'tts-pause', 'tts-cancel']) {
    receive({ type, sessionId: 'A', genId: 1 }, { tab: { id: 1 } });
  }
  await vi.waitFor(() => expect(ready).toBeTypeOf('function'));
  await Promise.resolve();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  ready([{}]);
  await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(3));
  expect(chrome.runtime.sendMessage.mock.calls.map(([m]) => m.type)).toEqual(['tts-play-paragraph', 'tts-pause', 'tts-cancel']);
});

it('returns asynchronous forwarding failures to the original identity', async () => {
  chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('offline'));
  receive({ type: 'tts-play-paragraph', sessionId: 'A', genId: 2 }, { tab: { id: 1 } });
  await vi.waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalled());
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ sessionId: 'A', genId: 2, fatal: true }));
});

it('answers profile patches from different tabs without creating an offscreen document', async () => {
  const stored = {};
  chrome.storage.local.get.mockImplementation(async keys => Object.fromEntries(keys.map(key => [key, stored[key]])));
  chrome.storage.local.set = async values => Object.assign(stored, values);
  const request = (language, patch, tabId) => new Promise(resolve => {
    expect(receive({ type: 'speech-profile-update', language, patch }, { tab: { id: tabId } }, resolve)).toBe(true);
  });
  await Promise.all([request('english', { speed: 1.7 }, 1), request('english', { voiceId: 'vera' }, 2), request('french', { speed: 0.8 }, 3)]);
  expect(stored['pocket-speechify-speech-profile-v1:english']).toEqual({ modelId: 'english', voiceId: 'vera', speed: 1.7 });
  expect(stored['pocket-speechify-speech-profile-v1:french'].speed).toBe(0.8);
  expect(chrome.runtime.getContexts).not.toHaveBeenCalled();
});

it('uses browser text detection and returns failures without forwarding them to audio', async () => {
  chrome.i18n = { detectLanguage: vi.fn(async () => ({ isReliable: true, languages: [{ language: 'fr', percentage: 100 }] })) };
  const request = () => new Promise(resolve => {
    expect(receive({ type: 'speech-detect-language', text: 'Bonjour' }, { tab: { id: 1 } }, resolve)).toBe(true);
  });
  expect(await request()).toEqual({ isReliable: true, languages: [{ language: 'fr', percentage: 100 }] });
  chrome.i18n.detectLanguage.mockRejectedValue(new Error('unavailable'));
  expect(await request()).toMatchObject({ error: 'Error: unavailable' });
  expect(chrome.runtime.getContexts).not.toHaveBeenCalled();
});
