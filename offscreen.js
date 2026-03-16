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

async function getCached(key) {
  const cache = await caches.open(CACHE_NAME);
  const resp = await cache.match(key);
  if (!resp) return null;
  return resp.arrayBuffer();
}

async function putCache(key, data) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(key, new Response(data));
}

async function deleteCache(key) {
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(key);
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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const percent = contentLength > 0 ? Math.round((received / contentLength) * 100) : -1;
      sendToServiceWorker({ type: 'download-progress', asset, voiceId, percent });
    }
  } catch (err) {
    // Network interrupted — save partial progress for resume
    const partial = mergeChunks(chunks, received);
    await putCache(partialKey, partial.buffer);
    await putCache(metaKey, new TextEncoder().encode(JSON.stringify({ received })).buffer);
    throw err;
  }

  // Download complete — store final data, clean up partial
  const fullBuffer = mergeChunks(chunks, received);
  await putCache(cacheKey, fullBuffer.buffer);
  await deleteCache(partialKey);
  await deleteCache(metaKey);
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

  switch (msg.type) {
    case 'tts-play':
      handlePlay(msg);
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
  }
});

async function handlePlay(msg) {
  const { genId, text, voiceId, speed, sentenceMeta } = msg;

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
    modelData = await downloadWithProgress(
      `${HF_BASE}/tts_b6369a24.safetensors`, modelKey, 'model', null,
    );
  }

  let voiceData = await getCached(voiceKey);
  if (!voiceData) {
    voiceData = await downloadWithProgress(
      `${HF_BASE}/embeddings_v2/${voiceId}.safetensors`, voiceKey, 'voice', voiceId,
    );
  }

  // Initialize word timing estimator
  const numWords = sentenceMeta.words.length;
  const estimatedFrames = Math.ceil((numWords / 3 + 2) * 12.5);
  const estimatedDurationSec = estimatedFrames / 12.5;
  wordTimingEstimator = createWordTimingEstimator(sentenceMeta.words, estimatedDurationSec);

  // Ensure worker has model + voice loaded
  await ensureWorker(modelData, voiceData, voiceId);

  // Reset playback timing after potentially long download
  nextStartTime = ctx.currentTime;
  playbackStartTime = ctx.currentTime;

  worker.postMessage({ type: 'generate', genId, text, voiceId });
}

async function ensureWorker(modelData, voiceData, voiceId) {
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL('src/tts-worker.js'));
    worker.onmessage = (e) => handleWorkerMessage(e.data);

    worker.postMessage({ type: 'load-model', modelData }, [modelData]);
    await waitForWorkerMessage('model-ready');
  }

  // Worker caches voices it has already loaded
  worker.postMessage({ type: 'load-voice', voiceId, voiceData }, [voiceData]);
  await waitForWorkerMessage('voice-ready');
}

function waitForWorkerMessage(expectedType) {
  return new Promise((resolve) => {
    const handler = (e) => {
      if (e.data.type === expectedType) {
        worker.removeEventListener('message', handler);
        resolve(e.data);
      }
    };
    worker.addEventListener('message', handler);
  });
}

function handleWorkerMessage(msg) {
  switch (msg.type) {
    case 'chunk': {
      scheduleAudioChunk(msg.data, msg.genId);
      break;
    }
    case 'done': {
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
