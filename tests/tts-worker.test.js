// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());

afterEach(() => {
  vi.unstubAllGlobals();
});

it('loads catalog configs and JSON tokenizers as public non-cloning models', async () => {
  const messages = [];
  vi.stubGlobal('self', { postMessage: message => messages.push(message) });
  // Exercise the real worker handler; replace only the expensive WASM engine.
  const moduleUrl = 'data:text/javascript,' + encodeURIComponent(`
    export default async function init() {}
    export class WasmTTSModel {
      sample_rate = 24000;
      load_from_buffer(config, weights, tokenizer, cloning) {
        if (cloning !== false) throw new Error('Public catalog must disable voice cloning');
        if (new TextDecoder().decode(config) !== 'sampler: upstream\\n') throw new Error('Config changed');
        if (weights[0] !== 17 || tokenizer[0] !== 123) throw new Error('Asset bytes changed');
      }
      is_ready() { return true; }
    }
  `);
  await import('../public/tts-worker.js');
  await self.onmessage({ data: {
    type: 'load-model', language: 'english_2026-09', wasmJsUrl: moduleUrl,
    configData: new TextEncoder().encode('sampler: upstream\n').buffer,
    modelData: new Uint8Array([17]).buffer,
    tokenizerData: new TextEncoder().encode('{}').buffer,
  } });
  expect(messages.filter(message => message.type !== 'diag')).toEqual([
    { type: 'model-ready', sampleRate: 24000, language: 'english_2026-09' },
  ]);
});

async function streamingWorker(timestamps = true) {
  const messages = [];
  const stream = {
    next_batch: vi.fn()
      .mockReturnValueOnce({ audio: new Float32Array([0.25]), events: [{ kind: 'word_start', word: 'Hi', word_index: 0, start_time: 0 }] })
      .mockReturnValueOnce({ audio: new Float32Array(), events: [{ kind: 'word_end', word: 'Hi', word_index: 0, start_time: 0, end_time: 0.08 }] }),
    next_chunk_min_samples: vi.fn().mockReturnValueOnce(new Float32Array([0.5])),
    free: vi.fn(),
  };
  vi.stubGlobal('testStream', stream);
  vi.stubGlobal('self', { postMessage: message => messages.push(message) });
  const wasmJsUrl = 'data:text/javascript,' + encodeURIComponent(`
    export default async function init() {}
    export class WasmTTSModel {
      sample_rate = 24000;
      load_from_buffer() {}
      is_ready() { return true; }
      start_stream_with_timestamps() { return globalThis.testStream; }
      start_stream() { return globalThis.testStream; }
    }
  `);
  await import('../public/tts-worker.js');
  await self.onmessage({ data: {
    type: 'load-model', wasmJsUrl, timestamps,
    configData: new ArrayBuffer(1), modelData: new ArrayBuffer(1), tokenizerData: new ArrayBuffer(1),
  } });
  return { messages, stream };
}

it('forwards timestamps before PCM and keeps the event-only final batch', async () => {
  const { messages, stream } = await streamingWorker();
  await self.onmessage({ data: { type: 'generate', genId: 1, text: 'Hi' } });
  expect(messages.filter(m => ['words', 'chunk', 'done'].includes(m.type))).toEqual([
    { type: 'words', genId: 1, events: [{ kind: 'word_start', word: 'Hi', word_index: 0, start_time: 0 }] },
    { type: 'chunk', genId: 1, data: new Float32Array([0.25]) },
    { type: 'words', genId: 1, events: [{ kind: 'word_end', word: 'Hi', word_index: 0, start_time: 0, end_time: 0.08 }] },
    { type: 'done', genId: 1 },
  ]);
  expect(stream.free).toHaveBeenCalledOnce();
});

it('uses audio-only streaming for models without calibrated heads', async () => {
  const { messages, stream } = await streamingWorker(false);
  await self.onmessage({ data: { type: 'generate', genId: 1, text: 'Hi' } });
  expect(messages.filter(m => m.type === 'chunk')[0].data).toEqual(new Float32Array([0.5]));
  expect(messages.some(m => m.type === 'words')).toBe(false);
  expect(stream.free).toHaveBeenCalledOnce();
});

it('frees the stream on inference errors', async () => {
  const { messages, stream } = await streamingWorker();
  stream.next_batch.mockImplementation(() => { throw new Error('inference failed'); });
  await self.onmessage({ data: { type: 'generate', genId: 1, text: 'Hi' } });
  expect(messages).toContainEqual({ type: 'error', genId: 1, error: 'Error: inference failed' });
  expect(stream.free).toHaveBeenCalledOnce();
});

it('frees a cancelled stream without emitting completion', async () => {
  const { messages, stream } = await streamingWorker();
  stream.next_batch.mockReset().mockImplementation(() => ({ audio: new Float32Array([0.25]), events: [] }));
  const generating = self.onmessage({ data: { type: 'generate', genId: 1, text: 'Hi' } });
  await self.onmessage({ data: { type: 'cancel', genId: 1 } });
  await generating;
  expect(messages.filter(m => m.type === 'chunk')).toHaveLength(6);
  expect(messages.some(m => m.type === 'done')).toBe(false);
  expect(stream.free).toHaveBeenCalledOnce();
});
