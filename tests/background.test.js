import { beforeEach, it, expect, vi } from 'vitest';

let receive;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('chrome', {
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
