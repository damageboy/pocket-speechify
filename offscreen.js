// offscreen.js
import { createWordTimingEstimator } from './src/word-timing-estimator.js';

const CACHE_NAME = 'pocket-tts-v1';
const SAMPLE_RATE = 24000;
const HF_BASE = 'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main';

// --- Audio queue config ---
const MAX_BUFFERED_SEC = 5; // don't generate more than 5s ahead of playback

let audioCtx = null;
let worker = null;
let currentGenId = -1;
let internalGenCounter = 0; // offscreen-owned monotonic counter, sent to worker instead of content script's genId
let currentSpeed = 1.0;
let paused = false;
let currentLoadedVoiceId = null;
let currentTabId = null;

// --- Audio Queue ---
// Chunks from the worker go into this queue. A scheduler drains it into AudioContext.
// Word events fire based on AudioContext playback time, not generation time.

let audioQueue = [];         // [{ data: Float32Array, genId, sentenceMeta, words }]
let scheduledSources = [];   // [{ source, startTime, endTime, genId }]
let nextStartTime = 0;
let playbackStartTime = 0;
let cumulativeScheduledSec = 0; // total raw audio seconds scheduled on AudioContext
let schedulerTimer = null;

// Per-sentence word timing state
let currentSentenceMeta = null;
let wordTimingEstimator = null;
let sentenceAudioSec = 0;    // raw audio seconds scheduled for current sentence
let pendingWordTimeouts = []; // timeout IDs for pending word events — cleared on sentence transition
let sentenceStartCtxTime = 0; // AudioContext.currentTime when this sentence's audio started scheduling

// Auto-regulation: calibrate word timing estimates from actual sentence durations.
// Tracks cumulative estimated vs actual across ALL sentences in a generation.
// calibrationFactor = totalActual / totalEstimated (converges as more data accumulates)
let totalEstimatedSec = 0;
let totalActualSec = 0;
let timingCalibrationFactor = 1.0;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }
  return audioCtx;
}

// --- Outbound messages ---

function sendToServiceWorker(msg) {
  chrome.runtime.sendMessage({ ...msg, source: 'offscreen' });
}

function logToSW(message) {
  console.log(message);
  sendToServiceWorker({ type: 'diag', message });
}

// --- Cache API helpers ---
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
  await cache.put(new Request(cacheUrl(key)), new Response(data));
}

async function deleteCache(key) {
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(cacheUrl(key));
}

// --- Resumable download with progress ---

async function downloadWithProgress(url, cacheKey, asset, voiceId) {
  const partialKey = cacheKey + '.partial';
  const metaKey = cacheKey + '.partial-meta';

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
  if (startByte > 0) headers['Range'] = `bytes=${startByte}-`;

  const resp = await fetch(url, { headers });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  }

  const contentLength = startByte + parseInt(resp.headers.get('content-length') || '0', 10);
  const reader = resp.body.getReader();
  const chunks = [...existingChunks];
  let received = startByte;

  let lastCheckpointBucket = -1;
  let lastProgressBucket = -1;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const percent = contentLength > 0 ? Math.round((received / contentLength) * 100) : -1;

      const progressBucket = Math.floor(percent / 2);
      if (progressBucket > lastProgressBucket) {
        lastProgressBucket = progressBucket;
        sendToServiceWorker({ type: 'download-progress', asset, voiceId, percent });
      }

      const checkpointBucket = Math.floor(percent / 10);
      if (checkpointBucket > lastCheckpointBucket) {
        lastCheckpointBucket = checkpointBucket;
        const partial = mergeChunks(chunks, received);
        await putCache(partialKey, partial.buffer);
        await putCache(metaKey, new TextEncoder().encode(JSON.stringify({ received })).buffer);
        logToSW(`[Offscreen] Checkpoint at ${percent}% (${(received / 1024 / 1024).toFixed(1)}MB)`);
      }
    }
  } catch (err) {
    const partial = mergeChunks(chunks, received);
    await putCache(partialKey, partial.buffer);
    await putCache(metaKey, new TextEncoder().encode(JSON.stringify({ received })).buffer);
    logToSW(`[Offscreen] Download interrupted at ${(received / 1024 / 1024).toFixed(1)}MB. Will resume.`);
    throw err;
  }

  const fullBuffer = mergeChunks(chunks, received);
  await putCache(cacheKey, fullBuffer.buffer);
  await deleteCache(partialKey);
  await deleteCache(metaKey);
  logToSW(`[Offscreen] ${asset}${voiceId ? ':' + voiceId : ''} cached (${(received / 1024 / 1024).toFixed(1)}MB)`);
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

// =================================================================
// AUDIO QUEUE & SCHEDULER
// =================================================================
//
// Flow: Worker generates chunks → enqueued in audioQueue
//       Scheduler drains queue → schedules on AudioContext
//       Word events fire synced to AudioContext.currentTime
//       Queue has bounded size → natural backpressure on worker
//
// The scheduler runs on a 50ms interval when playing.
// It schedules chunks from the queue onto AudioContext, keeping
// the buffer ~MAX_BUFFERED_SEC ahead of current playback position.

function getBufferedAheadSec() {
  const ctx = getAudioContext();
  return Math.max(0, nextStartTime - ctx.currentTime);
}

function enqueueChunk(data, workerGenId) {
  if (workerGenId !== internalGenCounter) return;
  audioQueue.push({ data, workerGenId });
  // Scheduler will pick it up
}

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(drainQueue, 50);
}

function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

function drainQueue() {
  if (paused) return;

  const ctx = getAudioContext();

  // Clean up finished sources
  const now = ctx.currentTime;
  scheduledSources = scheduledSources.filter(s => s.endTime > now);

  // Schedule chunks from queue while we have room
  while (audioQueue.length > 0 && getBufferedAheadSec() < MAX_BUFFERED_SEC) {
    const entry = audioQueue.shift();
    if (entry.workerGenId !== internalGenCounter) continue;
    scheduleOneChunk(entry.data);
  }

  // If worker is waiting for queue space, signal it can continue
  if (audioQueue.length < 10 && workerWaiting) {
    workerWaiting = false;
    worker.postMessage({ type: 'resume-generation' });
  }
}

function scheduleOneChunk(float32Data) {
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
  const endTime = nextStartTime + playDurationSec;

  const myInternalGen = internalGenCounter;
  scheduledSources.push({ source, startTime: nextStartTime, endTime, rawDuration: rawDurationSec });
  cumulativeScheduledSec += rawDurationSec;
  sentenceAudioSec += rawDurationSec;
  nextStartTime = endTime;

  // Word timing: emit events synced to AudioContext playback time
  if (wordTimingEstimator && currentSentenceMeta) {
    const events = wordTimingEstimator.feedAudioDuration(sentenceAudioSec);
    for (const evt of events) {
      const calibratedTime = evt.estimatedTimeSec * timingCalibrationFactor;
      const wordPlayTime = sentenceStartCtxTime + (calibratedTime / currentSpeed);
      const delay = Math.max(0, wordPlayTime - ctx.currentTime);
      // Use currentGenId for content-script-facing messages (tab-specific)
      const csGenId = currentGenId;
      const wordEvent = {
        type: 'tts-word',
        genId: csGenId,
        detail: {
          paragraphIndex: currentSentenceMeta.paragraphIndex,
          sentenceIndex: currentSentenceMeta.sentenceIndex,
          wordIndex: evt.wordIndex,
          word: evt.word,
        },
      };
      const tid = setTimeout(() => {
        if (myInternalGen !== internalGenCounter || paused) return;
        sendToServiceWorker(wordEvent);
      }, delay * 1000);
      pendingWordTimeouts.push(tid);
    }
  }

  // Elapsed time update (only when not paused)
  if (!paused) {
    sendToServiceWorker({
      type: 'tts-elapsed', genId: currentGenId, elapsedSec: cumulativeScheduledSec / currentSpeed,
    });
  }
}

function clearPendingWordEvents() {
  for (const tid of pendingWordTimeouts) clearTimeout(tid);
  pendingWordTimeouts = [];
}

// --- Backpressure: signal worker to pause/resume ---
let workerWaiting = false;

function checkBackpressure() {
  // If queue + scheduled buffer is too far ahead, tell worker to pause
  const totalBuffered = getBufferedAheadSec() + (audioQueue.length * 0.08); // ~0.08s per chunk
  if (totalBuffered > MAX_BUFFERED_SEC && !workerWaiting) {
    workerWaiting = true;
    worker.postMessage({ type: 'pause-generation' });
  }
}

// --- Cancel ---

function cancelGeneration(internalGen) {
  for (const { source } of scheduledSources) {
    try { source.stop(); source.disconnect(); } catch (_) {}
  }
  scheduledSources = [];
  audioQueue = [];
  clearPendingWordEvents();
  nextStartTime = 0;
  playbackStartTime = 0;
  sentenceStartCtxTime = 0;
  cumulativeScheduledSec = 0;
  sentenceAudioSec = 0;
  wordTimingEstimator = null;
  currentSentenceMeta = null;
  workerWaiting = false;
  stopScheduler();

  if (worker) {
    worker.postMessage({ type: 'cancel', genId: internalGen });
  }
}

// --- Message handling ---

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
      internalGenCounter++;
      cancelGeneration(internalGenCounter - 1);
      currentGenId = msg.genId;
      break;
    case 'tts-set-speed':
      handleSetSpeed(msg.speed);
      break;
    case 'tts-clear-cache':
      caches.delete(CACHE_NAME).then(deleted => {
        logToSW(`[Offscreen] Cache cleared: ${deleted}`);
        if (worker) { worker.terminate(); worker = null; }
        currentLoadedVoiceId = null;
      });
      break;
  }
});

async function handlePlay(msg) {
  const { genId, text, voiceId, speed, sentenceMeta } = msg;
  logToSW(`[Offscreen] handlePlay: genId=${genId}, text="${text?.substring(0, 50)}", voiceId=${voiceId}`);

  const isNewGeneration = genId > currentGenId || msg.tabId !== currentTabId;
  if (isNewGeneration) {
    internalGenCounter++;
    cancelGeneration(internalGenCounter - 1);
  }
  currentTabId = msg.tabId;
  // Clear pending word events from previous sentence to prevent stale highlights
  clearPendingWordEvents();

  // Auto-regulate: accumulate actual vs estimated duration from previous sentence
  if (!isNewGeneration && sentenceAudioSec > 0 && currentSentenceMeta) {
    const numWords = currentSentenceMeta.words?.length || 1;
    const estimatedFrames = Math.ceil((numWords / 3 + 2) * 12.5);
    const estimatedSec = estimatedFrames / 12.5;
    totalEstimatedSec += estimatedSec;
    totalActualSec += sentenceAudioSec;
    if (totalEstimatedSec > 0) {
      timingCalibrationFactor = totalActualSec / totalEstimatedSec;
      logToSW(`[Offscreen] Timing calibration: sentence est=${estimatedSec.toFixed(2)}s actual=${sentenceAudioSec.toFixed(2)}s | cumulative factor=${timingCalibrationFactor.toFixed(3)} (${totalActualSec.toFixed(1)}s/${totalEstimatedSec.toFixed(1)}s)`);
    }
  }

  currentGenId = genId;
  currentSpeed = speed;
  currentSentenceMeta = sentenceMeta;
  sentenceAudioSec = 0;

  const ctx = getAudioContext();

  if (isNewGeneration) {
    // Only unpause on explicit new play — not on sentence continuation
    paused = false;
    if (ctx.state === 'suspended') await ctx.resume();
    cumulativeScheduledSec = 0;
    nextStartTime = ctx.currentTime;
    playbackStartTime = ctx.currentTime;
    totalEstimatedSec = 0;
    totalActualSec = 0;
    timingCalibrationFactor = 1.0;
  }

  // If paused, don't proceed — the sentence will be generated into the queue
  // and played when the user resumes
  if (paused) {
    logToSW('[Offscreen] Paused — queueing sentence for later playback');
    // Still set up the word timing estimator so it's ready when we resume
  }

  // Record when this sentence's audio starts on the AudioContext timeline
  sentenceStartCtxTime = nextStartTime;

  // Initialize word timing estimator for this sentence
  const numWords = sentenceMeta.words.length;
  const estimatedFrames = Math.ceil((numWords / 3 + 2) * 12.5);
  const estimatedDurationSec = estimatedFrames / 12.5;
  wordTimingEstimator = createWordTimingEstimator(sentenceMeta.words, estimatedDurationSec);

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
    logToSW(`[Offscreen] Voice ${voiceId} not cached, downloading...`);
    voiceData = await downloadWithProgress(
      `${HF_BASE}/embeddings/${voiceId}.safetensors`, voiceKey, 'voice', voiceId,
    );
    logToSW(`[Offscreen] Voice ${voiceId} download complete`);
  } else {
    logToSW(`[Offscreen] Voice ${voiceId} loaded from cache`);
  }

  // Ensure worker has model + voice loaded
  await ensureWorker(modelData, voiceData, voiceId);

  // Reset timing after potentially long download (only for new generation)
  if (isNewGeneration) {
    nextStartTime = ctx.currentTime;
    playbackStartTime = ctx.currentTime;
  }

  // Start the audio scheduler
  startScheduler();

  // Use internalGenCounter for worker (not content script's genId — those aren't unique across tabs)
  worker.postMessage({ type: 'generate', genId: internalGenCounter, text, voiceId });
  logToSW(`[Offscreen] Generate sent to worker: internalGen=${internalGenCounter}`);
}

async function ensureWorker(modelData, voiceData, voiceId) {
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL('src/tts-worker.js'));
    worker.onmessage = (e) => handleWorkerMessage(e.data);
    worker.onerror = (e) => {
      logToSW(`[Offscreen] WORKER ERROR: ${e.message} at ${e.filename}:${e.lineno}`);
    };

    const cfgResp = await fetch(chrome.runtime.getURL('config.yaml'));
    const configData = await cfgResp.arrayBuffer();
    const wasmJsUrl = chrome.runtime.getURL('wasm/pocket_tts.js');

    worker.postMessage(
      { type: 'load-model', modelData, configData, wasmJsUrl },
      [modelData, configData],
    );
    await waitForWorkerMessage('model-ready');
  }

  if (currentLoadedVoiceId !== voiceId) {
    worker.postMessage({ type: 'load-voice', voiceId, voiceData });
    await waitForWorkerMessage('voice-ready');
    currentLoadedVoiceId = voiceId;
  }
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
  if (msg.type === 'diag') {
    console.log('[Worker]', msg.message);
    sendToServiceWorker({ type: 'diag', message: msg.message });
    return;
  }
  switch (msg.type) {
    case 'chunk': {
      enqueueChunk(msg.data, msg.genId);
      checkBackpressure();
      break;
    }
    case 'done': {
      logToSW(`[Offscreen] Worker done for genId: ${msg.genId} (internal=${internalGenCounter})`);
      if (msg.genId !== internalGenCounter) return;

      // Finalize word timing — schedule remaining words before sentence end
      if (wordTimingEstimator && currentSentenceMeta) {
        const remaining = wordTimingEstimator.finalize();
        const ctx = getAudioContext();
        for (const evt of remaining) {
          const calibratedTime = evt.estimatedTimeSec * timingCalibrationFactor;
          const wordPlayTime = sentenceStartCtxTime + (calibratedTime / currentSpeed);
          const delay = Math.max(0, wordPlayTime - ctx.currentTime);
          const wordEvent = {
            type: 'tts-word',
            genId: currentGenId,
            detail: {
              paragraphIndex: currentSentenceMeta.paragraphIndex,
              sentenceIndex: currentSentenceMeta.sentenceIndex,
              wordIndex: evt.wordIndex,
              word: evt.word,
            },
          };
          const myGen = internalGenCounter;
          const tid = setTimeout(() => {
            if (myGen !== internalGenCounter || paused) return;
            sendToServiceWorker(wordEvent);
          }, delay * 1000);
          pendingWordTimeouts.push(tid);
        }
      }

      // Signal sentence done — wait until audio actually finishes playing.
      // Use a polling approach so pause correctly delays the transition.
      const doneInternalGen = internalGenCounter;
      function checkSentenceDone() {
        if (doneInternalGen !== internalGenCounter) return; // cancelled
        if (paused) {
          // Re-check after a bit — pause delays sentence transition
          setTimeout(checkSentenceDone, 100);
          return;
        }
        const now = getAudioContext().currentTime;
        if (now >= nextStartTime - 0.05) {
          // Audio finished playing
          sendToServiceWorker({ type: 'tts-sentence-done', genId: currentGenId });
        } else {
          // Still playing — check again
          setTimeout(checkSentenceDone, Math.max(50, (nextStartTime - now) * 500));
        }
      }
      checkSentenceDone();
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
  stopScheduler();
  getAudioContext().suspend();
  // Worker can keep generating into the queue (bounded), but scheduler won't drain it
}

function handleResume() {
  paused = false;
  const ctx = getAudioContext();
  ctx.resume();
  startScheduler(); // resume draining queue
}

function handleSetSpeed(newSpeed) {
  const oldSpeed = currentSpeed;
  currentSpeed = newSpeed;
  const ctx = getAudioContext();

  for (const entry of scheduledSources) {
    try { entry.source.playbackRate.value = newSpeed; } catch (_) {}
  }

  // Recalculate nextStartTime based on remaining scheduled audio
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
