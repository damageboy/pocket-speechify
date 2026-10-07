import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ get browser() { return globalThis.browser; } }));

vi.mock('../src/stretch-processor.js', () => ({
  createStretchProcessor: async () => ({
    reset() {},
    flush: () => [],
    inputLatency: 0,
    outputLatency: 0,
    process: (data, speed) => new Float32Array(Math.round(data.length / speed)),
  }),
}));

let receive, messages, workers, contexts;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  messages = [];
  workers = [];
  contexts = [];
  vi.stubGlobal('browser', { storage: { local: { get: vi.fn(async () => ({})) } }, runtime: {
    onMessage: { addListener: fn => { receive = fn; } },
    sendMessage: msg => { messages.push(msg); },
    getURL: () => 'data:text/javascript,export default function(){}',
  } });
  vi.stubGlobal('caches', { open: async () => ({ match: async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }) }) });
  vi.stubGlobal('AudioContext', class {
    currentTime = 10;
    state = 'suspended';
    destination = {};
    constructor() { contexts.push(this); }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
    createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() {} }; }
  });
  vi.stubGlobal('Worker', class extends EventTarget {
    sent = [];
    constructor() { super(); workers.push(this); }
    postMessage(msg) {
      this.sent.push(msg);
      if (msg.type === 'load-model' || msg.type === 'load-voice') {
        queueMicrotask(() => this.emit({ type: msg.type === 'load-model' ? 'model-ready' : 'voice-ready' }));
      }
    }
    emit(data) {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
    terminate() {}
  });
  await import('../entrypoints/offscreen/main.js');
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function play(overrides = {}) {
  receive({
    source: 'service-worker', type: 'tts-play-paragraph', genId: 7, tabId: 9, sessionId: 'A',
    startPlayback: true,
    paragraphText: 'Skipped sentence. Tiny elephant.', paragraphIndex: 2,
    startSentenceIndex: 1, startParaWordOffset: 2, sentenceWordOffsets: [0, 2],
    language: 'english', voiceId: 'alba', speed: 1, ...overrides,
  });
  await vi.advanceTimersByTimeAsync(25);
  const worker = workers.at(-1);
  const request = worker.sent.findLast(m => m.type === 'generate');
  expect(request).toBeDefined();
  return { worker, genId: request.genId, ctx: contexts.at(-1), request };
}

const wordMessages = () => messages.filter(m => m.type === 'tts-word');

it('submits and reports processed text after seeking, retaining original highlight indices', async () => {
  browser.storage.local.get.mockResolvedValue({ 'pocket-speechify-text-rules': [
    { name: 'Title', pattern: 'Dr\\.', replacement: 'Medical doctor', flags: 'g', enabled: true },
    { name: 'Citation', pattern: '\\[12\\] ', replacement: '', flags: 'g', enabled: true },
  ] });
  const { request, worker, genId, ctx } = await play({ paragraphText: 'Skip this. Dr. Ada [12] arrived.' });
  expect(request.text).toBe('Medical doctor Ada arrived.');
  expect(messages.find(m => m.type === 'tts-processed-text')).toMatchObject({
    tabId: 9, sessionId: 'A', genId: 7,
    detail: { paragraphIndex: 2, text: 'Medical doctor Ada arrived.' },
  });
  worker.emit({ type: 'words', genId, events: [
    { kind: 'word_start', word: 'arrived', word_index: 3, start_time: 0.4 },
  ] });
  worker.emit({ type: 'chunk', genId, data: new Float32Array(24000) });
  await vi.advanceTimersByTimeAsync(25);
  ctx.currentTime = 10.5;
  await vi.advanceTimersByTimeAsync(25);
  expect(wordMessages().at(-1).detail.wordIndex).toBe(5);
});

it('skips fully removed paragraphs without sending blank text to WASM or recording a submission', async () => {
  browser.storage.local.get.mockResolvedValue({ 'pocket-speechify-text-rules': [
    { name: 'Remove', pattern: '[\\s\\S]+', replacement: '', flags: 'g', enabled: true },
  ] });
  receive({ source: 'service-worker', type: 'tts-play-paragraph', genId: 7, tabId: 9, sessionId: 'A',
    startPlayback: true, paragraphText: 'Remove me.', speed: 1 });
  await vi.advanceTimersByTimeAsync(25);
  expect(workers.flatMap(worker => worker.sent).some(m => m.type === 'generate')).toBe(false);
  expect(messages.some(m => m.type === 'tts-processed-text')).toBe(false);
  expect(messages.find(m => m.type === 'tts-paragraph-done')).toMatchObject({ sourceSec: 0, genId: 7 });
});

it('uses original text and exact seek offsets, and resumes each new paragraph audio context', async () => {
  const first = await play();
  expect(first.request.text).toBe('Tiny elephant.');
  expect(first.worker.sent.find(m => m.type === 'load-model').timestamps).toBe(true);
  first.worker.emit({ type: 'words', genId: first.genId, events: [
    { kind: 'word_start', word: 'Tiny', word_index: 0, start_time: 0.4 },
  ] });
  first.worker.emit({ type: 'chunk', genId: first.genId, data: new Float32Array(24000) });
  await vi.advanceTimersByTimeAsync(25);
  expect(wordMessages().at(-1).detail.wordIndex).toBeNull();
  first.ctx.currentTime = 10.5;
  await vi.advanceTimersByTimeAsync(25);
  expect(wordMessages().at(-1).detail).toEqual({ paragraphIndex: 2, wordIndex: 2, word: 'Tiny' });
  first.worker.emit({ type: 'done', genId: first.genId });
  first.ctx.currentTime = 11;
  await vi.advanceTimersByTimeAsync(25);
  expect(messages.filter(m => m.type === 'tts-paragraph-done')).toHaveLength(1);
  const next = await play({ paragraphIndex: 3, startPlayback: false });
  expect(next.genId).not.toBe(first.genId);
  expect(next.ctx.state).toBe('running');
});

it('keeps pending timestamps through pause and clears at the native word end', async () => {
  const { worker, genId, ctx } = await play();
  worker.emit({ type: 'words', genId, events: [
    { kind: 'word_start', word: 'Tiny', word_index: 0, start_time: 0.4 },
  ] });
  worker.emit({ type: 'chunk', genId, data: new Float32Array(24000) });
  await vi.advanceTimersByTimeAsync(25);
  receive({ source: 'service-worker', type: 'tts-pause', tabId: 9, sessionId: 'A', genId: 7 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(wordMessages().at(-1).detail.wordIndex).toBeNull();
  receive({ source: 'service-worker', type: 'tts-resume', tabId: 9, sessionId: 'A', genId: 7 });
  ctx.currentTime = 10.5;
  await vi.advanceTimersByTimeAsync(25);
  expect(wordMessages().at(-1).detail.wordIndex).toBe(2);
  worker.emit({ type: 'words', genId, events: [
    { kind: 'word_end', word: 'Tiny', word_index: 0, start_time: 0.4, end_time: 0.6 },
  ] });
  ctx.currentTime = 10.7;
  await vi.advanceTimersByTimeAsync(25);
  expect(wordMessages().at(-1).detail.wordIndex).toBeNull();
});

it('waits for queued as well as scheduled audio after generation finishes', async () => {
  const { worker, genId, ctx } = await play();
  for (let i = 0; i < 8; i++) worker.emit({ type: 'chunk', genId, data: new Float32Array(24000) });
  worker.emit({ type: 'done', genId });
  ctx.currentTime = 15;
  await vi.advanceTimersByTimeAsync(25);
  expect(messages.some(m => m.type === 'tts-paragraph-done')).toBe(false);
  ctx.currentTime = 18;
  await vi.advanceTimersByTimeAsync(25);
  expect(messages.filter(m => m.type === 'tts-paragraph-done')).toHaveLength(1);
});

it('ignores late events and completion from a cancelled generation', async () => {
  const { worker, genId } = await play();
  receive({ source: 'service-worker', type: 'tts-cancel', genId: 7, tabId: 9, sessionId: 'A' });
  const count = wordMessages().length;
  const contextCount = contexts.length;
  worker.emit({ type: 'words', genId, events: [{ kind: 'word_start', word: 'Tiny', word_index: 0, start_time: 0 }] });
  worker.emit({ type: 'chunk', genId, data: new Float32Array(24000) });
  worker.emit({ type: 'done', genId });
  await vi.advanceTimersByTimeAsync(1000);
  expect(wordMessages()).toHaveLength(count);
  expect(contexts).toHaveLength(contextCount);
  expect(messages.some(m => m.type === 'tts-paragraph-done')).toBe(false);
});

it('uses the speed of each scheduled chunk rather than the newest speed', async () => {
  const { worker, genId, ctx } = await play();
  worker.emit({ type: 'words', genId, events: [
    { kind: 'word_end', word: 'Tiny', word_index: 0, start_time: 0.2, end_time: 1 },
    { kind: 'word_start', word: 'elephant', word_index: 1, start_time: 1.6 },
  ] });
  worker.emit({ type: 'chunk', genId, data: new Float32Array(24000) });
  await vi.advanceTimersByTimeAsync(25);
  receive({ source: 'service-worker', type: 'tts-set-speed', speed: 2, genId: 7, tabId: 9, sessionId: 'A' });
  worker.emit({ type: 'chunk', genId, data: new Float32Array(24000) });
  ctx.currentTime = 10.5;
  await vi.advanceTimersByTimeAsync(25);
  expect(wordMessages().at(-1).detail.word).toBe('Tiny');
  ctx.currentTime = 11.25;
  await vi.advanceTimersByTimeAsync(25);
  expect(wordMessages().at(-1).detail.wordIndex).toBeNull();
  ctx.currentTime = 11.31;
  await vi.advanceTimersByTimeAsync(25);
  expect(wordMessages().at(-1).detail.word).toBe('elephant');
});

it('does not enable unsupported timestamp APIs for audio-only models', async () => {
  const { worker } = await play({ language: 'german', voiceId: 'juergen' });
  expect(worker.sent.find(m => m.type === 'load-model').timestamps).toBe(false);
});

it('supersedes ownership and rejects old-tab and old-generation controls', async () => {
  await play();
  const next = await play({ tabId: 10, sessionId: 'B' });
  expect(messages.find(m => m.type === 'tts-superseded')).toMatchObject({ tabId: 9, sessionId: 'A', genId: 7 });
  for (const type of ['tts-pause', 'tts-resume', 'tts-cancel', 'tts-set-speed']) {
    receive({ source: 'service-worker', type, tabId: 9, sessionId: 'A', genId: 7, speed: 4 });
    receive({ source: 'service-worker', type, tabId: 10, sessionId: 'B', genId: 6, speed: 4 });
  }
  expect(next.ctx.state).toBe('running');
  next.worker.emit({ type: 'chunk', genId: next.genId, data: new Float32Array(24000) });
  next.worker.emit({ type: 'done', genId: next.genId });
  next.ctx.currentTime = 11;
  await vi.advanceTimersByTimeAsync(25);
  expect(messages.find(m => m.type === 'tts-paragraph-done')).toMatchObject({ tabId: 10, sessionId: 'B', genId: 7, sourceSec: 1 });
});

it('keeps asynchronous load failure attached to its original owner', async () => {
  let rejectFetch;
  caches.open = async () => ({ match: async () => null });
  vi.stubGlobal('fetch', () => new Promise((resolve, reject) => { rejectFetch = reject; }));
  receive({ source: 'service-worker', type: 'tts-play-paragraph', tabId: 9, sessionId: 'A', genId: 7, startPlayback: true, paragraphText: 'Hello', speed: 1 });
  await vi.advanceTimersByTimeAsync(0);
  const failOld = rejectFetch;
  caches.open = async () => ({ match: async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }) });
  await play({ tabId: 10, sessionId: 'B' });
  failOld(new Error('old download failed'));
  await vi.advanceTimersByTimeAsync(0);
  expect(messages.find(m => m.type === 'tts-paragraph-done')).toMatchObject({ tabId: 9, sessionId: 'A', genId: 7, fatal: true });
});

it.each([200, 206])('resumes download with HTTP %i and caches exactly the final bytes', async status => {
  const { getModelCacheKey } = await import('../src/languages.js');
  const key = getModelCacheKey('english');
  const url = k => `https://pocket-tts-cache.local/${k}`;
  const entries = new Map([
    [url(key + '.partial'), new Uint8Array([1, 2]).buffer],
    [url(key + '.partial-meta'), new TextEncoder().encode('{"received":2}').buffer],
  ]);
  let modelMissing = true;
  let finishDownload;
  caches.open = async () => ({
    match: async k => {
      if (k === url(key) && modelMissing) return null;
      if (entries.has(k)) return { arrayBuffer: async () => entries.get(k) };
      if (k.endsWith('.partial') || k.endsWith('.partial-meta')) return null;
      return { arrayBuffer: async () => new ArrayBuffer(1) };
    },
    put: async (req, resp) => { entries.set(req.url, await resp.arrayBuffer()); },
    delete: async k => entries.delete(k),
  });
  vi.stubGlobal('fetch', vi.fn(async () => {
    let read = false;
    const bytes = new Uint8Array(status === 200 ? [1, 2, 3, 4] : [3, 4]);
    const response = { ok: true, status, headers: new Headers({ 'content-length': String(bytes.length) }),
      body: { getReader: () => ({ read: async () => {
        if (read) return { done: true };
        read = true;
        return { done: false, value: bytes };
      } }) },
    };
    return new Promise(resolve => { finishDownload = () => resolve(response); });
  }));
  receive({ source: 'service-worker', type: 'tts-play-paragraph', tabId: 9,
    sessionId: 'A', genId: 7, startPlayback: true, paragraphText: 'Hello.', speed: 1 });
  await vi.advanceTimersByTimeAsync(0);
  modelMissing = false;
  const next = await play({ tabId: 10, sessionId: 'B' });
  finishDownload();
  await vi.advanceTimersByTimeAsync(25);
  expect(fetch).toHaveBeenCalledWith(expect.any(String), { headers: { Range: 'bytes=2-' } });
  expect([...new Uint8Array(entries.get(url(key)))]).toEqual([1, 2, 3, 4]);
  expect(entries.has(url(key + '.partial'))).toBe(false);
  expect(entries.has(url(key + '.partial-meta'))).toBe(false);
  expect(messages.find(m => m.type === 'download-progress')).toMatchObject({ tabId: 9, sessionId: 'A', genId: 7, percent: 100 });
  expect(messages.find(m => m.type === 'download-complete')).toMatchObject({ tabId: 9, sessionId: 'A', genId: 7 });
  expect(next.ctx.state).toBe('running');
});

it('rejects a late old paragraph continuation without reclaiming the new owner', async () => {
  const old = await play();
  old.worker.emit({ type: 'done', genId: old.genId });
  await vi.advanceTimersByTimeAsync(0);
  const next = await play({ tabId: 10, sessionId: 'B' });
  const count = contexts.length;
  receive({ source: 'service-worker', type: 'tts-play-paragraph', tabId: 9,
    sessionId: 'A', genId: 7, startPlayback: false, paragraphText: 'Late old paragraph.', speed: 1 });
  old.worker.emit({ type: 'done', genId: old.genId });
  await vi.advanceTimersByTimeAsync(25);
  expect(contexts).toHaveLength(count);
  expect(next.ctx.state).toBe('running');
  expect(next.worker.sent.findLast(m => m.type === 'generate').genId).toBe(next.genId);
});

it.each(['tts-pause', 'tts-cancel'])('honors %s while rules are loading', async type => {
  let loaded;
  browser.storage.local.get.mockReturnValueOnce(new Promise(resolve => { loaded = resolve; }));
  receive({ source: 'service-worker', type: 'tts-play-paragraph', tabId: 9,
    sessionId: 'A', genId: 7, startPlayback: true, paragraphText: 'Hello.',
    paragraphIndex: 0, startSentenceIndex: 0, sentenceWordOffsets: [0], speed: 1 });
  receive({ source: 'service-worker', type, tabId: 9, sessionId: 'A', genId: 7 });
  loaded({});
  await vi.advanceTimersByTimeAsync(25);
  if (type === 'tts-pause') expect(contexts.at(-1).state).toBe('suspended');
  else {
    expect(workers).toHaveLength(0);
    expect(messages.some(m => m.type === 'tts-processed-text')).toBe(false);
  }
});

it.each(['tts-pause', 'tts-cancel'])('honors %s while the first play is awaiting model download', async type => {
  const { getModelCacheKey } = await import('../src/languages.js');
  let loaded;
  caches.open = async () => ({ match: async key => ({ arrayBuffer: async () => {
    if (key.endsWith('/' + getModelCacheKey('english'))) return new Promise(resolve => { loaded = resolve; });
    return new ArrayBuffer(1);
  } }) });
  receive({ source: 'service-worker', type: 'tts-play-paragraph', tabId: 9,
    sessionId: 'A', genId: 7, startPlayback: true, paragraphText: 'Hello.',
    paragraphIndex: 0, startSentenceIndex: 0, sentenceWordOffsets: [0], speed: 1 });
  await vi.advanceTimersByTimeAsync(0);
  const ctx = contexts.at(-1);
  receive({ source: 'service-worker', type, tabId: 9, sessionId: 'A', genId: 7 });
  loaded(new ArrayBuffer(1));
  await vi.advanceTimersByTimeAsync(25);
  expect(ctx.state).toBe(type === 'tts-pause' ? 'suspended' : 'closed');
  expect(messages.some(m => m.type === 'tts-paragraph-done')).toBe(false);
  if (type === 'tts-cancel') expect(workers).toHaveLength(0);
  else {
    receive({ source: 'service-worker', type: 'tts-resume', tabId: 9, sessionId: 'A', genId: 7 });
    expect(ctx.state).toBe('running');
  }
});
