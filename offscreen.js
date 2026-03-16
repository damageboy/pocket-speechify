// offscreen.js
import { createWordTimingEstimator } from './src/word-timing-estimator.js';

const CACHE_NAME = 'pocket-tts-v1';
const SAMPLE_RATE = 24000;
const HF_BASE = 'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main';

let audioCtx = null;
let worker = null;
let currentGenId = -1;
let nextStartTime = 0;
let playbackStartTime = 0;
let scheduledSources = [];
let cumulativeAudioSec = 0;
let currentSpeed = 1.0;
let paused = false;
let deferredEvents = [];
let currentSentenceMeta = null;
let wordTimingEstimator = null;

// --- AudioContext ---

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }
  return audioCtx;
}

// --- Outbound messages (always tagged with source: 'offscreen') ---

function sendToServiceWorker(msg) {
  chrome.runtime.sendMessage({ ...msg, source: 'offscreen' });
}

// --- Cache API helpers ---
// Cache API requires URL-like keys. We use a fake https URL as the key.
function cacheUrl(key) {
  return `https://pocket-tts-cache.local/${key}`;
}

async function getCached(key) {
  const cache = await caches.open(CACHE_NAME);
  const resp = await cache.match(cacheUrl(key));
  if (!resp) return null;
  return resp.arrayBuffer();
}

async function putCache(key, data) {
  const cache = await caches.open(CACHE_NAME);
  const req = new Request(cacheUrl(key));
  await cache.put(req, new Response(data));
}

async function deleteCache(key) {
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(cacheUrl(key));
}

// --- Resumable download with progress ---

async function downloadWithProgress(url, cacheKey, asset, voiceId) {
  const partialKey = cacheKey + '.partial';
  const metaKey = cacheKey + '.partial-meta';

  // Check for partial download
  let startByte = 0;
  let existingChunks = [];
  const metaResp = await getCached(metaKey);
  if (metaResp) {
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(metaResp)));
    startByte = meta.received;
    const partialData = await getCached(partialKey);
    if (partialData) {
      existingChunks.push(new Uint8Array(partialData));
    } else {
      startByte = 0;
    }
  }

  const headers = {};
  if (startByte > 0) {
    headers['Range'] = `bytes=${startByte}-`;
  }

  const resp = await fetch(url, { headers });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  }

  const contentLength = startByte + parseInt(
    resp.headers.get('content-length') || '0', 10
  );
  const reader = resp.body.getReader();
  const chunks = [...existingChunks];
  let received = startByte;

  let lastCheckpointPercent = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const percent = contentLength > 0 ? Math.round((received / contentLength) * 100) : -1;
      sendToServiceWorker({ type: 'download-progress', asset, voiceId, percent });

      // Periodically checkpoint partial data every 10% so progress survives
      // offscreen document being killed by Chrome
      if (percent >= lastCheckpointPercent + 10) {
        lastCheckpointPercent = Math.floor(percent / 10) * 10;
        const partial = mergeChunks(chunks, received);
        await putCache(partialKey, partial.buffer);
        await putCache(metaKey, new TextEncoder().encode(JSON.stringify({ received })).buffer);
        console.log(`[Offscreen] Checkpoint saved at ${percent}% (${(received / 1024 / 1024).toFixed(1)}MB)`);
      }
    }
  } catch (err) {
    // Network interrupted — save partial progress for resume
    const partial = mergeChunks(chunks, received);
    await putCache(partialKey, partial.buffer);
    await putCache(metaKey, new TextEncoder().encode(JSON.stringify({ received })).buffer);
    console.log(`[Offscreen] Download interrupted at ${(received / 1024 / 1024).toFixed(1)}MB. Will resume on next attempt.`);
    throw err;
  }

  // Download complete — store final data, clean up partial
  const fullBuffer = mergeChunks(chunks, received);
  await putCache(cacheKey, fullBuffer.buffer);
  await deleteCache(partialKey);
  await deleteCache(metaKey);
  console.log(`[Offscreen] ${asset}${voiceId ? ':' + voiceId : ''} cached (${(received / 1024 / 1024).toFixed(1)}MB). No re-download needed on next use.`);
  sendToServiceWorker({ type: 'download-complete', asset, voiceId });
  return fullBuffer.buffer;
}

function mergeChunks(chunks, totalBytes) {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// --- Audio scheduling ---

function scheduleAudioChunk(float32Data, genId) {
  if (genId !== currentGenId) return;

  const ctx = getAudioContext();
  const buffer = ctx.createBuffer(1, float32Data.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(float32Data);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = currentSpeed;
  source.connect(ctx.destination);

  nextStartTime = Math.max(nextStartTime, ctx.currentTime);
  source.start(nextStartTime);

  const rawDurationSec = float32Data.length / SAMPLE_RATE;
  const playDurationSec = rawDurationSec / currentSpeed;

  scheduledSources.push({ source, startTime: nextStartTime, rawDuration: rawDurationSec });
  cumulativeAudioSec += rawDurationSec;
  nextStartTime += playDurationSec;

  // Run word timing estimator
  if (wordTimingEstimator && currentSentenceMeta) {
    const events = wordTimingEstimator.feedAudioDuration(cumulativeAudioSec);
    for (const evt of events) {
      const wordEvent = {
        type: 'tts-word',
        genId,
        detail: {
          paragraphIndex: currentSentenceMeta.paragraphIndex,
          sentenceIndex: currentSentenceMeta.sentenceIndex,
          wordIndex: evt.wordIndex,
          word: evt.word,
        },
      };
      const playTime = playbackStartTime + (evt.estimatedTimeSec / currentSpeed);
      scheduleWordEvent(wordEvent, playTime);
    }
  }

  // Send elapsed time update
  sendToServiceWorker({
    type: 'tts-elapsed', genId, elapsedSec: cumulativeAudioSec / currentSpeed,
  });
}

function scheduleWordEvent(wordEvent, audioCtxTime) {
  if (paused) {
    deferredEvents.push({ wordEvent, audioCtxTime });
    return;
  }
  const ctx = getAudioContext();
  const delay = Math.max(0, audioCtxTime - ctx.currentTime);
  setTimeout(() => {
    sendToServiceWorker(wordEvent);
  }, delay * 1000);
}

// --- Cancel ---

function cancelGeneration(genId) {
  for (const { source } of scheduledSources) {
    try { source.stop(); source.disconnect(); } catch (_) {}
  }
  scheduledSources = [];
  nextStartTime = 0;
  playbackStartTime = 0;
  cumulativeAudioSec = 0;
  deferredEvents = [];
  wordTimingEstimator = null;
  currentSentenceMeta = null;

  if (worker) {
    worker.postMessage({ type: 'cancel', genId });
  }
}

// --- Message handling (only process messages from service worker) ---

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type || msg.source !== 'service-worker') return;
  logToSW(`[Offscreen] Received: ${msg.type}`);

  switch (msg.type) {
    case 'tts-play':
      handlePlay(msg).catch(err => {
        console.error('[Offscreen] handlePlay error:', err);
        sendToServiceWorker({ type: 'tts-sentence-done', genId: msg.genId, error: err.message });
      });
      break;
    case 'tts-pause':
      handlePause();
      break;
    case 'tts-resume':
      handleResume();
      break;
    case 'tts-cancel':
      cancelGeneration(msg.genId);
      currentGenId = msg.genId;
      break;
    case 'tts-set-speed':
      handleSetSpeed(msg.speed);
      break;
    case 'tts-clear-cache':
      caches.delete(CACHE_NAME).then(deleted => {
        logToSW(`[Offscreen] Cache cleared: ${deleted}`);
        // Kill the worker so model gets reloaded from scratch
        if (worker) {
          worker.terminate();
          worker = null;
        }
      });
      break;
  }
});

function logToSW(message) {
  console.log(message);
  sendToServiceWorker({ type: 'diag', message });
}

async function handlePlay(msg) {
  const { genId, text, voiceId, speed, sentenceMeta } = msg;
  logToSW(`[Offscreen] handlePlay: genId=${genId}, text="${text?.substring(0, 50)}", voiceId=${voiceId}`);

  if (genId > currentGenId) {
    cancelGeneration(currentGenId);
  }
  currentGenId = genId;
  currentSpeed = speed;
  currentSentenceMeta = sentenceMeta;
  cumulativeAudioSec = 0;
  paused = false;

  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  nextStartTime = ctx.currentTime;
  playbackStartTime = ctx.currentTime;

  // Ensure model + voice are downloaded
  const modelKey = `${CACHE_NAME}/model/tts_b6369a24.safetensors`;
  const voiceKey = `${CACHE_NAME}/voice/${voiceId}.safetensors`;

  let modelData = await getCached(modelKey);
  if (!modelData) {
    logToSW('[Offscreen] Model not cached, downloading (~236MB)...');
    modelData = await downloadWithProgress(
      `${HF_BASE}/tts_b6369a24.safetensors`, modelKey, 'model', null,
    );
    logToSW('[Offscreen] Model download complete');
  } else {
    logToSW('[Offscreen] Model loaded from cache');
  }

  let voiceData = await getCached(voiceKey);
  if (!voiceData) {
    console.log(`[Offscreen] Voice ${voiceId} not cached, downloading...`);
    voiceData = await downloadWithProgress(
      `${HF_BASE}/embeddings/${voiceId}.safetensors`, voiceKey, 'voice', voiceId,
    );
    console.log(`[Offscreen] Voice ${voiceId} download complete`);
  } else {
    console.log(`[Offscreen] Voice ${voiceId} loaded from cache`);
  }

  // Initialize word timing estimator
  const numWords = sentenceMeta.words.length;
  const estimatedFrames = Math.ceil((numWords / 3 + 2) * 12.5);
  const estimatedDurationSec = estimatedFrames / 12.5;
  wordTimingEstimator = createWordTimingEstimator(sentenceMeta.words, estimatedDurationSec);

  // Ensure worker has model + voice loaded
  logToSW('[Offscreen] Loading model + voice into WASM worker...');
  await ensureWorker(modelData, voiceData, voiceId);
  logToSW('[Offscreen] Worker ready. Starting generation...');

  // Reset playback timing after potentially long download
  nextStartTime = ctx.currentTime;
  playbackStartTime = ctx.currentTime;

  worker.postMessage({ type: 'generate', genId, text, voiceId });
  logToSW('[Offscreen] Generate message sent to worker');
}

async function ensureWorker(modelData, voiceData, voiceId) {
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL('src/tts-worker.js'));
    worker.onmessage = (e) => handleWorkerMessage(e.data);
    worker.onerror = (e) => {
      logToSW(`[Offscreen] WORKER ERROR: ${e.message} at ${e.filename}:${e.lineno}`);
    };

    // Fetch config and WASM glue URL here — workers can't access chrome.runtime
    // Tokenizer is NOT needed — the WASM binary has tokenizer.json embedded via include_bytes!
    const cfgResp = await fetch(chrome.runtime.getURL('config.yaml'));
    const configData = await cfgResp.arrayBuffer();
    const wasmJsUrl = chrome.runtime.getURL('wasm/pocket_tts.js');

    worker.postMessage(
      { type: 'load-model', modelData, configData, wasmJsUrl },
      [modelData, configData],
    );
    await waitForWorkerMessage('model-ready');
  }

  // WASM model stores a single voice state — always load the requested voice
  // Don't transfer voiceData (we might need to reload it if offscreen doc is recreated)
  worker.postMessage({ type: 'load-voice', voiceId, voiceData });
  await waitForWorkerMessage('voice-ready');
}

function waitForWorkerMessage(expectedType, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener('message', handler);
      reject(new Error(`Timeout waiting for worker message: ${expectedType}`));
    }, timeoutMs);
    const handler = (e) => {
      if (e.data.type === expectedType) {
        clearTimeout(timer);
        worker.removeEventListener('message', handler);
        resolve(e.data);
      } else if (e.data.type === 'error') {
        clearTimeout(timer);
        worker.removeEventListener('message', handler);
        reject(new Error(e.data.error || 'Worker error during ' + expectedType));
      }
    };
    worker.addEventListener('message', handler);
  });
}

function handleWorkerMessage(msg) {
  // Forward worker diagnostics to service worker so they appear in its console
  if (msg.type === 'diag') {
    console.log('[Worker]', msg.message);
    sendToServiceWorker({ type: 'diag', message: msg.message });
    return;
  }
  switch (msg.type) {
    case 'chunk': {
      console.log(`[Offscreen] Audio chunk: ${msg.data.length} samples`);
      scheduleAudioChunk(msg.data, msg.genId);
      break;
    }
    case 'done': {
      logToSW(`[Offscreen] Generation done for genId: ${msg.genId}`);
      if (msg.genId !== currentGenId) return;
      if (wordTimingEstimator) {
        const remaining = wordTimingEstimator.finalize();
        for (const evt of remaining) {
          sendToServiceWorker({
            type: 'tts-word',
            genId: currentGenId,
            detail: {
              paragraphIndex: currentSentenceMeta.paragraphIndex,
              sentenceIndex: currentSentenceMeta.sentenceIndex,
              wordIndex: evt.wordIndex,
              word: evt.word,
            },
          });
        }
      }
      sendToServiceWorker({ type: 'tts-sentence-done', genId: currentGenId });
      break;
    }
    case 'error': {
      console.error('[Pocket Speechify] Worker error:', msg.error);
      sendToServiceWorker({
        type: 'tts-sentence-done', genId: currentGenId, error: msg.error,
      });
      break;
    }
  }
}

function handlePause() {
  paused = true;
  getAudioContext().suspend();
}

function handleResume() {
  paused = false;
  const ctx = getAudioContext();
  ctx.resume();

  // Re-schedule deferred word events with corrected timing
  for (const { wordEvent, audioCtxTime } of deferredEvents) {
    const delay = Math.max(0, audioCtxTime - ctx.currentTime);
    setTimeout(() => sendToServiceWorker(wordEvent), delay * 1000);
  }
  deferredEvents = [];
}

function handleSetSpeed(newSpeed) {
  const oldSpeed = currentSpeed;
  currentSpeed = newSpeed;
  const ctx = getAudioContext();

  // Update playbackRate on all scheduled sources
  for (const entry of scheduledSources) {
    try { entry.source.playbackRate.value = newSpeed; } catch (_) {}
  }

  // Recalculate nextStartTime
  const now = ctx.currentTime;
  let lastEndTime = now;
  for (const entry of scheduledSources) {
    const elapsed = Math.max(0, now - entry.startTime);
    const originalPlayDuration = entry.rawDuration / oldSpeed;
    const remaining = Math.max(0, originalPlayDuration - elapsed);
    const newRemaining = remaining * (oldSpeed / newSpeed);
    const newEnd = now + newRemaining;
    if (newEnd > lastEndTime) lastEndTime = newEnd;
  }
  nextStartTime = lastEndTime;
}
