// offscreen.js
import { createWordTimingEstimator } from '../../src/word-timing-estimator.js';
import { createStretchProcessor } from '../../src/stretch-processor.js';

// Signalsmith Stretch — must stay vendored (npm API incompatible).
// Dynamic import: WASM is embedded in the .mjs, import.meta.url must resolve to public/lib/
let SignalsmithStretchModule;

// text-processing-rs — must stay dynamic.
// WASM glue uses import.meta.url to resolve sibling .wasm file.
// If Vite bundles this statically, import.meta.url points to wrong location → 404.
let initTextProcessing, tnNormalizeSentence;

const CACHE_NAME = 'pocket-tts-v1';
const SAMPLE_RATE = 24000;
const HF_BASE = 'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main';

// --- Audio pipeline config ---
const MAX_BUFFERED_SEC = 5; // don't generate more than 5s ahead of playback

let audioCtx = null;
let worker = null;
let currentGenId = -1;
let internalGenCounter = 0;
let currentSpeed = 1.0;
let paused = false;
let currentLoadedVoiceId = null;
let currentTabId = null;

// --- Direct WASM stretch processor ---
// Matches the Rust ssstretch::Stretch pattern: process(input, inputLen, output, outputLen)
// Each chunk is time-stretched offline, then scheduled at 1.0x playbackRate.
let stretchProcessor = null;

// --- Audio Queue & Scheduler ---
let audioQueue = [];         // [{ data: Float32Array, workerGenId }]
let scheduledSources = [];   // [{ source, startTime, endTime, rawDuration }]
let nextStartTime = 0;
let playbackStartTime = 0;
let cumulativeScheduledSec = 0;
let schedulerTimer = null;

// Per-sentence word timing state
let currentSentenceMeta = null;
let wordTimingEstimator = null;
let sentenceAudioSec = 0;
let pendingWordTimeouts = [];
let sentenceStartCtxTime = 0;

// Auto-regulation calibration
let totalEstimatedSec = 0;
let totalActualSec = 0;
let timingCalibrationFactor = 1.0;

// Backpressure
let workerWaiting = false;

// Per-sentence completion promise (resolved when sentence audio finishes playing)
let sentenceDoneResolve = null;

// Text normalization (text-processing-rs WASM)
let textProcessingPromise = null;
function ensureTextProcessing() {
  if (!textProcessingPromise) {
    textProcessingPromise = (async () => {
      const tpModule = await import(browser.runtime.getURL('lib/text-processing-rs/text_processing_rs.js'));
      initTextProcessing = tpModule.default;
      tnNormalizeSentence = tpModule.tnNormalizeSentence;
      await initTextProcessing();
      logToSW('[Offscreen] text-processing-rs initialized');
    })();
  }
  return textProcessingPromise;
}

// Abbreviation expansion (loaded once from data/abbreviations.json)
let abbreviations = null;
async function loadAbbreviations() {
  if (abbreviations !== null) return abbreviations;
  const resp = await fetch(browser.runtime.getURL('data/abbreviations.json'));
  abbreviations = await resp.json();
  logToSW(`[Offscreen] Loaded ${Object.keys(abbreviations).length} abbreviation(s)`);
  return abbreviations;
}

function expandAbbreviations(text, abbrevMap) {
  let result = text;
  for (const [written, spoken] of Object.entries(abbrevMap)) {
    result = result.replaceAll(written, spoken);
  }
  return result;
}

// Abbreviation-aware sentence splitter used on normalized paragraph text.
// Avoids false splits on known abbreviations (Dr., Mr., Jan., U.S., etc.).
const ABBREV_WORDS = new Set([
  'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr', 'St', 'Rev', 'Lt', 'Col', 'Gen',
  'Gov', 'Rep', 'Sen', 'vs', 'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug',
  'Sep', 'Oct', 'Nov', 'Dec', 'Corp', 'Inc', 'Ltd', 'Dept', 'e.g', 'i.e',
  'U.S', 'U.K', 'U.N', 'a.m', 'p.m',
]);

function splitSentencesOffscreen(text) {
  const parts = text.split(/([.!?]+(?:\s+|$))/);
  const sentences = [];
  let current = '';
  for (let i = 0; i < parts.length; i++) {
    current += parts[i];
    if (i % 2 === 1) {
      const trimmed = current.trim();
      if (!trimmed) { current = ''; continue; }
      // Check if the last word is a known abbreviation — if so, don't split here
      const words = trimmed.split(/\s+/);
      const lastWord = words[words.length - 1].replace(/\.$/, '');
      if (ABBREV_WORDS.has(lastWord) || /^[A-Z]$/.test(lastWord)) {
        continue; // accumulate into next fragment
      }
      sentences.push(trimmed);
      current = '';
    }
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences.filter(s => s.length > 0);
}

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }
  return audioCtx;
}

// --- Outbound messages ---

function sendToServiceWorker(msg) {
  browser.runtime.sendMessage({ ...msg, source: 'offscreen' });
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
// Flow: Worker generates chunks → stretch-processor time-stretches each chunk
//       → stretched audio scheduled as AudioBufferSource at 1.0x playbackRate
//       → destination
//
// This matches the Rust ssstretch pattern: process(input, inputLen, output, outputLen)
// where outputLen = inputLen / speed. Pitch is naturally preserved by the STFT.

function getBufferedAheadSec() {
  const ctx = getAudioContext();
  return Math.max(0, nextStartTime - ctx.currentTime);
}

function enqueueChunk(data, workerGenId) {
  if (workerGenId !== internalGenCounter) return;
  audioQueue.push({ data, workerGenId });
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
  const now = ctx.currentTime;
  scheduledSources = scheduledSources.filter(s => s.endTime > now);

  while (audioQueue.length > 0 && getBufferedAheadSec() < MAX_BUFFERED_SEC) {
    const entry = audioQueue.shift();
    if (entry.workerGenId !== internalGenCounter) continue;
    scheduleOneChunk(entry.data);
  }

  if (audioQueue.length < 10 && workerWaiting) {
    workerWaiting = false;
    worker.postMessage({ type: 'resume-generation' });
  }
}

function scheduleOneChunk(float32Data) {
  const ctx = getAudioContext();

  // Time-stretch the chunk: inputLen → outputLen = inputLen / speed
  // At speed=1.0 this is a no-op (outputLen == inputLen).
  const rawDurationSec = float32Data.length / SAMPLE_RATE;
  let stretchedData;
  if (stretchProcessor && Math.abs(currentSpeed - 1.0) > 0.001) {
    stretchedData = stretchProcessor.process(float32Data, currentSpeed);
  } else {
    stretchedData = float32Data;
  }

  const buffer = ctx.createBuffer(1, stretchedData.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(stretchedData);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  // playbackRate is always 1.0 — speed change is in the stretched data
  source.connect(ctx.destination);

  nextStartTime = Math.max(nextStartTime, ctx.currentTime);
  source.start(nextStartTime);

  const playDurationSec = stretchedData.length / SAMPLE_RATE;
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
      const csGenId = currentGenId;
      const paraWordIdx = currentSentenceMeta.words[evt.wordIndex]?.paraWordIdx ?? evt.wordIndex;
      const wordEvent = {
        type: 'tts-word',
        genId: csGenId,
        detail: {
          paragraphIndex: currentSentenceMeta.paragraphIndex,
          wordIndex: paraWordIdx,
          word: currentSentenceMeta.words[evt.wordIndex]?.text || evt.word,
        },
      };
      const tid = setTimeout(() => {
        if (myInternalGen !== internalGenCounter || paused) return;
        sendToServiceWorker(wordEvent);
      }, delay * 1000);
      pendingWordTimeouts.push(tid);
    }
  }

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

function checkBackpressure() {
  const totalBuffered = getBufferedAheadSec() + (audioQueue.length * 0.08);
  if (totalBuffered > MAX_BUFFERED_SEC && !workerWaiting) {
    workerWaiting = true;
    worker.postMessage({ type: 'pause-generation' });
  }
}

// --- Cancel ---

function cancelGeneration(internalGen) {
  // Disconnect all scheduled sources. Separate try/catch blocks are critical: if stop()
  // throws (e.g. InvalidStateError when context is suspended and the source hasn't been
  // processed by the audio thread yet), disconnect() must still run so the source cannot
  // produce any output when the context resumes.
  for (const { source } of scheduledSources) {
    try { source.stop(); } catch (_) {}
    try { source.disconnect(); } catch (_) {}
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

  // Close the AudioContext so any in-flight or scheduled audio is immediately destroyed.
  // A fresh context is created lazily by getAudioContext() on the next play call.
  if (audioCtx) {
    const oldCtx = audioCtx;
    audioCtx = null;
    oldCtx.close().catch(() => {});
  }

  if (worker) {
    worker.postMessage({ type: 'cancel', genId: internalGen });
  }

  // Unblock any paragraph loop awaiting sentence completion
  if (sentenceDoneResolve) {
    const resolve = sentenceDoneResolve;
    sentenceDoneResolve = null;
    resolve();
  }
}

// --- Message handling ---

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type || msg.source !== 'service-worker') return;
  logToSW(`[Offscreen] Received: ${msg.type}`);

  switch (msg.type) {
    case 'tts-play-paragraph':
      handlePlayParagraph(msg).catch(err => {
        console.error('[Offscreen] handlePlayParagraph error:', err);
        sendToServiceWorker({ type: 'tts-paragraph-done', genId: msg.genId, error: err.message });
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

async function handlePlayParagraph(msg) {
  const { genId, paragraphText, paragraphIndex, startSentenceIndex,
          originalSentenceCount, originalWordCount, startParaWordOffset,
          voiceId, speed, tabId } = msg;
  logToSW(`[Offscreen] handlePlayParagraph: genId=${genId}, pIdx=${paragraphIndex}, text="${paragraphText?.substring(0, 50)}"`);

  const isNewGeneration = genId !== currentGenId || tabId !== currentTabId;
  if (isNewGeneration) {
    internalGenCounter++;
    cancelGeneration(internalGenCounter - 1);
  }
  currentTabId = tabId;
  clearPendingWordEvents();

  currentGenId = genId;
  currentSpeed = speed;
  const myInternalGen = internalGenCounter;

  const ctx = getAudioContext();

  if (isNewGeneration) {
    paused = false;
    if (ctx.state === 'suspended') await ctx.resume();
    cumulativeScheduledSec = 0;
    nextStartTime = ctx.currentTime;
    playbackStartTime = ctx.currentTime;
    totalEstimatedSec = 0;
    totalActualSec = 0;
    timingCalibrationFactor = 1.0;
  }

  // Always reset stretch processor between paragraphs to flush STFT
  // overlap-add state that would otherwise bleed the previous paragraph's
  // tail audio into the next paragraph's first chunk.
  if (stretchProcessor) stretchProcessor.reset();

  // Ensure model + voice are downloaded
  const modelKey = `${CACHE_NAME}/model/tts_b6369a24.safetensors`;
  const voiceKey = `${CACHE_NAME}/voice/${voiceId}.safetensors`;

  let modelData = await getCached(modelKey);
  if (!modelData) {
    logToSW('[Offscreen] Model not cached, downloading (~236MB)...');
    modelData = await downloadWithProgress(`${HF_BASE}/tts_b6369a24.safetensors`, modelKey, 'model', null);
    logToSW('[Offscreen] Model download complete');
  } else {
    logToSW('[Offscreen] Model loaded from cache');
  }

  let voiceData = await getCached(voiceKey);
  if (!voiceData) {
    logToSW(`[Offscreen] Voice ${voiceId} not cached, downloading...`);
    voiceData = await downloadWithProgress(`${HF_BASE}/embeddings/${voiceId}.safetensors`, voiceKey, 'voice', voiceId);
    logToSW(`[Offscreen] Voice ${voiceId} download complete`);
  } else {
    logToSW(`[Offscreen] Voice ${voiceId} loaded from cache`);
  }

  await ensureWorker(modelData, voiceData, voiceId);

  if (!stretchProcessor) {
    const ssModule = await import(browser.runtime.getURL('lib/signalsmith-stretch/SignalsmithStretchModule.mjs'));
    SignalsmithStretchModule = ssModule.default;
    stretchProcessor = await createStretchProcessor(SignalsmithStretchModule, SAMPLE_RATE, 1);
    logToSW('[Offscreen] StretchProcessor initialized (direct WASM)');
  }

  if (isNewGeneration) {
    nextStartTime = ctx.currentTime;
    playbackStartTime = ctx.currentTime;
  }

  startScheduler();

  // Expand abbreviations, then normalize full paragraph text before sentence splitting
  const abbrevMap = await loadAbbreviations();
  const expandedParaText = expandAbbreviations(paragraphText, abbrevMap);
  await ensureTextProcessing();
  const normalizedParaText = tnNormalizeSentence(expandedParaText);
  if (normalizedParaText !== expandedParaText) {
    logToSW(`[Offscreen] Para TN: "${expandedParaText.substring(0, 60)}" → "${normalizedParaText.substring(0, 60)}"`);
  }

  // Split normalized paragraph into sentences using abbreviation-aware splitter
  const normSentences = splitSentencesOffscreen(normalizedParaText);
  const normTotal = normSentences.length;
  const origTotal = originalSentenceCount || 1;

  // Map startSentenceIndex (original) to normalized sentence index
  const startNormIdx = origTotal > 0
    ? Math.min(Math.round(startSentenceIndex * normTotal / origTotal), Math.max(0, normTotal - 1))
    : 0;

  logToSW(`[Offscreen] Para ${paragraphIndex}: ${normTotal} norm sentences (orig ${origTotal}), starting at norm[${startNormIdx}]`);

  // Running paragraph-level word offset — increments by actual normalized word count per sentence
  let paraWordOffset = startParaWordOffset || 0;
  // Skip ahead past any normalized sentences before our start index
  for (let nIdx = 0; nIdx < startNormIdx; nIdx++) {
    paraWordOffset += normSentences[nIdx].trim().split(/\s+/).filter(Boolean).length;
  }

  for (let nIdx = startNormIdx; nIdx < normSentences.length; nIdx++) {
    if (myInternalGen !== internalGenCounter) return;

    const normSentText = normSentences[nIdx].trim();
    if (!normSentText) continue;

    // Map normalized sentence index back to original sentence index (for sentence events and history)
    const origSentIdx = Math.min(Math.round(nIdx * origTotal / normTotal), origTotal - 1);

    // Update timing calibration from previous sentence
    if (nIdx > startNormIdx && sentenceAudioSec > 0 && currentSentenceMeta) {
      const prevNumWords = currentSentenceMeta.words?.length || 1;
      const estimatedFrames = Math.ceil((prevNumWords / 3 + 2) * 12.5);
      const estimatedSec = estimatedFrames / 12.5;
      totalEstimatedSec += estimatedSec;
      totalActualSec += sentenceAudioSec;
      if (totalEstimatedSec > 0) {
        timingCalibrationFactor = totalActualSec / totalEstimatedSec;
        logToSW(`[Offscreen] Timing calibration: factor=${timingCalibrationFactor.toFixed(3)}`);
      }
    }

    // Build normalized word list with paragraph-relative word index for each word
    const normWordTexts = normSentText.split(/\s+/).filter(Boolean);
    const numNormWords = normWordTexts.length;
    const maxParaWordIdx = Math.max(0, (originalWordCount || 1) - 1);
    const sentenceWords = normWordTexts.map((w, i) => ({
      text: w,
      startOffset: 0,
      endOffset: w.length,
      paraWordIdx: Math.min(paraWordOffset + i, maxParaWordIdx),
    }));

    currentSentenceMeta = { paragraphIndex, sentenceIndex: origSentIdx, words: sentenceWords };
    sentenceAudioSec = 0;
    sentenceStartCtxTime = nextStartTime;

    const estimatedFrames = Math.ceil((numNormWords / 3 + 2) * 12.5);
    wordTimingEstimator = createWordTimingEstimator(sentenceWords, estimatedFrames / 12.5);

    // Notify content script that a new sentence is starting
    sendToServiceWorker({
      type: 'tts-sentence-event',
      genId: currentGenId,
      detail: { paragraphIndex, sentenceIndex: origSentIdx, text: normSentText },
    });

    worker.postMessage({ type: 'generate', genId: myInternalGen, text: normSentText, voiceId });
    logToSW(`[Offscreen] Generate norm[${nIdx}]→origSent[${origSentIdx}]: "${normSentText.substring(0, 60)}"`);

    // Wait for this sentence's audio to finish playing before moving to the next
    await new Promise(resolve => { sentenceDoneResolve = resolve; });
    sentenceDoneResolve = null;

    if (myInternalGen !== internalGenCounter) return;

    // Advance paragraph-level word offset by the number of words just spoken
    paraWordOffset += numNormWords;
  }

  // Contribute the last sentence of this paragraph to calibration.
  // The in-loop update runs at the START of each sentence N+1 using sentence N's data,
  // so the final sentence never gets a chance to update — we do it here instead.
  if (sentenceAudioSec > 0 && currentSentenceMeta) {
    const lastNumWords = currentSentenceMeta.words?.length || 1;
    const estimatedFrames = Math.ceil((lastNumWords / 3 + 2) * 12.5);
    const estimatedSec = estimatedFrames / 12.5;
    totalEstimatedSec += estimatedSec;
    totalActualSec += sentenceAudioSec;
    if (totalEstimatedSec > 0) {
      timingCalibrationFactor = totalActualSec / totalEstimatedSec;
      logToSW(`[Offscreen] Post-para timing calibration: factor=${timingCalibrationFactor.toFixed(3)}`);
    }
  }

  sendToServiceWorker({ type: 'tts-paragraph-done', genId: currentGenId });
  logToSW(`[Offscreen] Paragraph ${paragraphIndex} complete`);
}

async function ensureWorker(modelData, voiceData, voiceId) {
  if (!worker) {
    worker = new Worker(browser.runtime.getURL('tts-worker.js'));
    worker.onmessage = (e) => handleWorkerMessage(e.data);
    worker.onerror = (e) => {
      logToSW(`[Offscreen] WORKER ERROR: ${e.message} at ${e.filename}:${e.lineno}`);
    };

    const cfgResp = await fetch(browser.runtime.getURL('config.yaml'));
    const configData = await cfgResp.arrayBuffer();
    const wasmJsUrl = browser.runtime.getURL('wasm/pocket_tts.js');

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

      // Finalize word timing
      if (wordTimingEstimator && currentSentenceMeta) {
        const remaining = wordTimingEstimator.finalize();
        const ctx = getAudioContext();
        for (const evt of remaining) {
          const calibratedTime = evt.estimatedTimeSec * timingCalibrationFactor;
          const wordPlayTime = sentenceStartCtxTime + (calibratedTime / currentSpeed);
          const delay = Math.max(0, wordPlayTime - ctx.currentTime);
          const paraWordIdx = currentSentenceMeta.words[evt.wordIndex]?.paraWordIdx ?? evt.wordIndex;
          const wordEvent = {
            type: 'tts-word',
            genId: currentGenId,
            detail: {
              paragraphIndex: currentSentenceMeta.paragraphIndex,
              wordIndex: paraWordIdx,
              word: currentSentenceMeta.words[evt.wordIndex]?.text || evt.word,
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

      // Wait for audio to finish, then resolve the sentence promise in handlePlayParagraph
      const doneInternalGen = internalGenCounter;
      function checkAndResolve() {
        if (doneInternalGen !== internalGenCounter) {
          if (sentenceDoneResolve) { sentenceDoneResolve(); sentenceDoneResolve = null; }
          return;
        }
        if (paused) { setTimeout(checkAndResolve, 100); return; }
        const now = getAudioContext().currentTime;
        if (now >= nextStartTime - 0.05) {
          if (sentenceDoneResolve) { sentenceDoneResolve(); sentenceDoneResolve = null; }
        } else {
          setTimeout(checkAndResolve, Math.max(50, (nextStartTime - now) * 500));
        }
      }
      checkAndResolve();
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
}

function handleResume() {
  paused = false;
  const ctx = getAudioContext();
  ctx.resume();
  startScheduler();
}

function handleSetSpeed(newSpeed) {
  currentSpeed = newSpeed;
  const ctx = getAudioContext();

  // Future chunks will be stretched at the new speed.
  // Already-scheduled sources play at 1.0x with their already-stretched data.
  // No playbackRate changes needed — the stretching is baked into the audio data.
  logToSW(`[Offscreen] Speed changed to ${newSpeed}x (takes effect on next chunk)`);

  // Note: for already-buffered-but-not-yet-scheduled chunks in audioQueue,
  // they'll be stretched at the new speed when drainQueue processes them.
  // This gives near-instant speed changes for buffered audio.
}
