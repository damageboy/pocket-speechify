// offscreen.js
import { createWordTimeline } from '../../src/word-timeline.js';
import { createStretchProcessor } from '../../src/stretch-processor.js';
import { loadTextRules, preprocessText } from '../../src/text-rules.js';
import {
  DEFAULT_LANGUAGE_ID,
  buildLanguageConfigYaml,
  getDefaultVoiceForLanguage,
  getModelCacheKey,
  getTokenizerCacheKey,
  getVoiceCacheKey,
  getModelUrl,
  getTokenizerUrl,
  getVoiceUrl,
} from '../../src/languages.js';
import { getTTSLoadPlan } from '../../src/tts-load-policy.js';

// Signalsmith Stretch — must stay vendored (npm API incompatible).
// Dynamic import: WASM is embedded in the .mjs, import.meta.url must resolve to public/lib/
let SignalsmithStretchModule;

const CACHE_NAME = 'pocket-tts-v2';
const SAMPLE_RATE = 24000;

// --- Audio pipeline config ---
const MAX_BUFFERED_SEC = 5; // don't generate more than 5s ahead of playback

let audioCtx = null;
let worker = null;
let currentGenId = -1;
let internalGenCounter = 0;
let activeLoadToken = 0;
let currentSpeed = 1.0;
let paused = false;
let currentLoadedVoiceId = null;
let currentLoadedLanguage = null;
let playbackOwner = null; // { tabId, sessionId, genId }; survives service-worker restarts.

// --- Direct WASM stretch processor ---
// Matches the Rust ssstretch::Stretch pattern: process(input, inputLen, output, outputLen)
// Each chunk is time-stretched offline, then scheduled at 1.0x playbackRate.
let stretchProcessor = null;

// --- Audio Queue & Scheduler ---
let audioQueue = [];         // [{ data: Float32Array, workerGenId }]
let scheduledSources = [];   // [{ source, endTime }]
let nextStartTime = 0;
let paragraphSourceSec = 0; // generated audio at 1x for the current paragraph
let schedulerTimer = null;

// One native timestamp timeline per paragraph stream.
let currentParagraphMeta = null;
let wordTimeline = null;
let lastWordIndex = null;
let generationDone = false;
let stretchFlushed = false;

// Backpressure
let workerWaiting = false;

// Resolved only after generation AND all queued/scheduled audio finish.
let paragraphDoneResolve = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }
  return audioCtx;
}

// --- Outbound messages ---

function sendToServiceWorker(msg, owner = playbackOwner) {
  browser.runtime.sendMessage({ ...owner, ...msg, source: 'offscreen' });
}

function isOwner(msg) {
  return playbackOwner && msg.tabId === playbackOwner.tabId &&
    msg.sessionId === playbackOwner.sessionId && msg.genId === playbackOwner.genId;
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

async function downloadWithProgress(url, cacheKey, asset, voiceId, language, owner) {
  const partialKey = cacheKey + '.partial';
  const metaKey = cacheKey + '.partial-meta';

  let startByte = 0;
  const existingChunks = [];
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

  // A server may ignore Range and return the entire file. Never prepend the prefix.
  if (resp.status === 200) {
    startByte = 0;
    existingChunks.length = 0;
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
        sendToServiceWorker({ type: 'download-progress', asset, voiceId, language, percent }, owner);
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
  logToSW(`[Offscreen] ${asset}${voiceId ? ':' + voiceId : ''}${language ? ` (${language})` : ''} cached (${(received / 1024 / 1024).toFixed(1)}MB)`);
  sendToServiceWorker({ type: 'download-complete', asset, voiceId, language }, owner);
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
  schedulerTimer = setInterval(drainQueue, 25);
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
    // Keep the stretcher continuous even at 1x so speed changes preserve its
    // delay line and the source/output timeline remains continuous.
    scheduleOneChunk(stretchProcessor.process(entry.data, currentSpeed), entry.data.length / SAMPLE_RATE);
  }
  if (generationDone && audioQueue.length === 0 && !stretchFlushed) {
    stretchFlushed = true;
    for (const chunk of stretchProcessor.flush(currentSpeed)) {
      scheduleOneChunk(chunk.data, chunk.inputSamples / SAMPLE_RATE);
    }
  }

  if (audioQueue.length < 10 && workerWaiting) {
    workerWaiting = false;
    worker.postMessage({ type: 'resume-generation' });
  }
  updateWordHighlight();
  if (generationDone && audioQueue.length === 0 && ctx.currentTime >= nextStartTime) {
    stopScheduler();
    if (paragraphDoneResolve) {
      const resolve = paragraphDoneResolve;
      paragraphDoneResolve = null;
      resolve();
    }
  }
}

function scheduleOneChunk(stretchedData, rawDurationSec) {
  const ctx = getAudioContext();

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

  scheduledSources.push({ source, endTime });
  paragraphSourceSec += rawDurationSec;
  wordTimeline?.addAudio(rawDurationSec, nextStartTime, endTime);
  nextStartTime = endTime;
}

function updateWordHighlight() {
  if (!wordTimeline || !currentParagraphMeta) return;
  const word = wordTimeline.wordAt(getAudioContext().currentTime);
  const wordIndex = word?.wordIndex ?? null;
  if (wordIndex === lastWordIndex) return;
  lastWordIndex = wordIndex;
  const { paragraphIndex, sentenceWordOffsets } = currentParagraphMeta;
  if (word) {
    const sentenceIndex = sentenceWordOffsets.findLastIndex(offset => offset <= wordIndex);
    if (sentenceIndex !== currentParagraphMeta.sentenceIndex) {
      currentParagraphMeta.sentenceIndex = sentenceIndex;
      sendToServiceWorker({
        type: 'tts-sentence-event', genId: currentGenId,
        detail: { paragraphIndex, sentenceIndex },
      });
    }
  }
  sendToServiceWorker({
    type: 'tts-word', genId: currentGenId,
    detail: { paragraphIndex, wordIndex, word: word?.word ?? '' },
  });
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
  nextStartTime = 0;
  paragraphSourceSec = 0;
  wordTimeline = null;
  currentParagraphMeta = null;
  lastWordIndex = null;
  generationDone = false;
  stretchFlushed = false;
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

  // Unblock the cancelled paragraph request.
  if (paragraphDoneResolve) {
    const resolve = paragraphDoneResolve;
    paragraphDoneResolve = null;
    resolve();
  }
}

// --- Message handling ---

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type || msg.source !== 'service-worker') return;
  logToSW(`[Offscreen] Received: ${msg.type}`);
  if (['tts-pause', 'tts-resume', 'tts-cancel', 'tts-set-speed'].includes(msg.type) && !isOwner(msg)) return;

  switch (msg.type) {
    case 'tts-play-paragraph':
      handlePlayParagraph(msg).catch(err => {
        console.error('[Offscreen] handlePlayParagraph error:', err);
        // Load/download failures affect every paragraph: report them as fatal.
        sendToServiceWorker({ type: 'tts-paragraph-done', error: err.message, fatal: true }, {
          tabId: msg.tabId, sessionId: msg.sessionId, genId: msg.genId,
        });
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
      activeLoadToken++;
      cancelGeneration(internalGenCounter - 1);
      currentGenId = msg.genId;
      playbackOwner = null;
      break;
    case 'tts-set-speed':
      handleSetSpeed(msg.speed);
      break;
    case 'tts-clear-cache': {
      const clearLoadToken = ++activeLoadToken;
      caches.delete(CACHE_NAME).then(deleted => {
        if (clearLoadToken !== activeLoadToken) return;
        logToSW(`[Offscreen] Cache cleared: ${deleted}`);
        if (worker) { worker.terminate(); worker = null; }
        currentLoadedVoiceId = null;
        currentLoadedLanguage = null;
      });
      break;
    }
  }
});

async function getOrDownloadAsset({ cacheKey, url, asset, voiceId = null, language }, owner) {
  const cachedData = await getCached(cacheKey);
  if (cachedData) {
    logToSW(`[Offscreen] ${asset}${voiceId ? ':' + voiceId : ''} (${language}) loaded from cache`);
    return cachedData;
  }

  logToSW(`[Offscreen] ${asset}${voiceId ? ':' + voiceId : ''} (${language}) not cached, downloading...`);
  const downloadedData = await downloadWithProgress(url, cacheKey, asset, voiceId, language, owner);
  logToSW(`[Offscreen] ${asset}${voiceId ? ':' + voiceId : ''} (${language}) download complete`);
  return downloadedData;
}

async function loadModelAssets(language, owner) {
  const [modelData, tokenizerData] = await Promise.all([
    getOrDownloadAsset({
      cacheKey: getModelCacheKey(language),
      url: getModelUrl(language),
      asset: 'model',
      language,
    }, owner),
    getOrDownloadAsset({
      cacheKey: getTokenizerCacheKey(language),
      url: getTokenizerUrl(language),
      asset: 'tokenizer',
      language,
    }, owner),
  ]);
  const configData = new TextEncoder().encode(buildLanguageConfigYaml(language)).buffer;
  return { modelData, tokenizerData, configData };
}

async function loadVoiceAsset(language, voiceId, owner) {
  return getOrDownloadAsset({
    cacheKey: getVoiceCacheKey(language, voiceId),
    url: getVoiceUrl(language, voiceId),
    asset: 'voice',
    voiceId,
    language,
  }, owner);
}

async function handlePlayParagraph(msg) {
  // Only an explicit play can take ownership; a late completion's next paragraph cannot.
  if (!msg.startPlayback && !isOwner(msg)) {
    sendToServiceWorker({ type: 'tts-superseded' }, {
      tabId: msg.tabId, sessionId: msg.sessionId, genId: msg.genId,
    });
    return;
  }
  const {
    genId,
    paragraphText,
    paragraphIndex,
    startSentenceIndex,
    sentenceWordOffsets,
    startParaWordOffset = 0,
    voiceId,
    language = DEFAULT_LANGUAGE_ID,
    speed,
    tabId,
    sessionId,
  } = msg;
  const effectiveVoiceId = voiceId || getDefaultVoiceForLanguage(language);
  logToSW(`[Offscreen] handlePlayParagraph: genId=${genId}, pIdx=${paragraphIndex}, language=${language}, voice=${effectiveVoiceId}, text="${paragraphText?.substring(0, 50)}"`);

  const isNewGeneration = !isOwner(msg);
  if (isNewGeneration && playbackOwner) {
    sendToServiceWorker({ type: 'tts-superseded' }, playbackOwner);
  }
  const owner = { tabId, sessionId, genId };
  // Give every paragraph a unique worker ID, including continuous playback.
  internalGenCounter++;
  cancelGeneration(internalGenCounter - 1);
  playbackOwner = owner;

  currentGenId = genId;
  currentSpeed = speed;
  const myInternalGen = internalGenCounter;
  const myLoadToken = ++activeLoadToken;
  if (isNewGeneration) paused = false;

  // Seek in original page coordinates before applying the saved rules. Read
  // them for each submission so settings changes also reach already-open tabs.
  const pageWords = [...paragraphText.matchAll(/\S+/g)];
  const startOffset = pageWords[startParaWordOffset]?.index ?? paragraphText.length;
  const sourceText = paragraphText.slice(startOffset);
  const rules = await loadTextRules(browser.storage.local);
  if (myInternalGen !== internalGenCounter || myLoadToken !== activeLoadToken) return;
  const processed = preprocessText(sourceText, rules);
  const { text } = processed;
  if (!text.trim()) {
    sendToServiceWorker({ type: 'tts-paragraph-done', sourceSec: 0 }, owner);
    return;
  }

  const ctx = getAudioContext();

  if (!paused && ctx.state === 'suspended') await ctx.resume();
  if (myInternalGen !== internalGenCounter || myLoadToken !== activeLoadToken) return;
  nextStartTime = ctx.currentTime;

  // Always reset stretch processor between paragraphs to flush STFT
  // overlap-add state that would otherwise bleed the previous paragraph's
  // tail audio into the next paragraph's first chunk.
  if (stretchProcessor) stretchProcessor.reset();

  const loadPlan = getTTSLoadPlan({
    hasWorker: Boolean(worker),
    currentLoadedLanguage,
    currentLoadedVoiceId,
    language,
    voiceId: effectiveVoiceId,
  });

  const modelAssets = loadPlan.loadModel ? await loadModelAssets(language, owner) : null;
  const voiceData = loadPlan.loadVoice ? await loadVoiceAsset(language, effectiveVoiceId, owner) : null;
  if (myInternalGen !== internalGenCounter || myLoadToken !== activeLoadToken) return;

  const workerReady = await ensureWorker(modelAssets, voiceData, effectiveVoiceId, language, myInternalGen, myLoadToken);
  if (!workerReady || myInternalGen !== internalGenCounter || myLoadToken !== activeLoadToken) return;

  if (!stretchProcessor) {
    const ssModule = await import(browser.runtime.getURL('lib/signalsmith-stretch/SignalsmithStretchModule.mjs'));
    SignalsmithStretchModule = ssModule.default;
    stretchProcessor = await createStretchProcessor(SignalsmithStretchModule, SAMPLE_RATE, 1);
    logToSW('[Offscreen] StretchProcessor initialized (direct WASM)');
  }
  if (myInternalGen !== internalGenCounter || myLoadToken !== activeLoadToken) return;

  if (isNewGeneration) {
    nextStartTime = ctx.currentTime;
  }

  // Match engine spelling against processed text, then map back to the page.
  wordTimeline = createWordTimeline(sourceText, startParaWordOffset, {
    processed,
    inputLatency: stretchProcessor.inputLatency / SAMPLE_RATE,
    outputLatency: stretchProcessor.outputLatency / SAMPLE_RATE,
  });
  currentParagraphMeta = { paragraphIndex, sentenceWordOffsets, sentenceIndex: startSentenceIndex };
  sendToServiceWorker({
    type: 'tts-sentence-event', genId,
    detail: { paragraphIndex, sentenceIndex: startSentenceIndex },
  }, owner);
  // Clear the previous page word while waiting for the first native boundary.
  sendToServiceWorker({ type: 'tts-word', genId, detail: { paragraphIndex, wordIndex: null, word: '' } }, owner);
  const finished = new Promise(resolve => { paragraphDoneResolve = resolve; });
  startScheduler();
  worker.postMessage({ type: 'generate', genId: myInternalGen, text, voiceId: effectiveVoiceId });
  sendToServiceWorker({ type: 'tts-processed-text', detail: { paragraphIndex, text } }, owner);
  await finished;
  if (myInternalGen !== internalGenCounter || myLoadToken !== activeLoadToken) return;

  // Report the paragraph's audio length at 1x so the page can calibrate its
  // remaining-time estimate.
  sendToServiceWorker({ type: 'tts-paragraph-done', sourceSec: paragraphSourceSec }, owner);
  logToSW(`[Offscreen] Paragraph ${paragraphIndex} complete`);
}

async function ensureWorker(modelAssets, voiceData, voiceId, language, requestInternalGen, loadToken) {
  const isCurrent = () => requestInternalGen === internalGenCounter && loadToken === activeLoadToken;
  const isStaleLoadError = (err) => err?.name === 'StaleWorkerWait';

  if (!isCurrent()) return false;

  const mustLoadModel = !worker || currentLoadedLanguage !== language;

  if (mustLoadModel) {
    if (!modelAssets) throw new Error(`Missing model assets for language ${language}`);
    const { modelData, tokenizerData, configData } = modelAssets;
    if (!isCurrent()) return false;
    if (worker) { worker.terminate(); worker = null; }
    currentLoadedVoiceId = null;
    currentLoadedLanguage = null;
    worker = new Worker(browser.runtime.getURL('tts-worker.js'));
    worker.onmessage = (e) => handleWorkerMessage(e.data);
    worker.onerror = (e) => {
      logToSW(`[Offscreen] WORKER ERROR: ${e.message} at ${e.filename}:${e.lineno}`);
    };
    const wasmJsUrl = browser.runtime.getURL('wasm/pocket_tts.js');
    const timestamps = /^timestamp_heads:\s*\[/m.test(buildLanguageConfigYaml(language));
    if (!timestamps) logToSW(`[Offscreen] ${language} has no calibrated timestamp heads; playing without word highlights`);
    const workerForLoad = worker;
    workerForLoad.postMessage(
      { type: 'load-model', modelData, tokenizerData, configData, wasmJsUrl, language, timestamps },
      [modelData, tokenizerData, configData],
    );
    if (!isCurrent()) return false;
    try {
      await waitForWorkerMessage('model-ready', 30000, workerForLoad, isCurrent);
    } catch (err) {
      if (isStaleLoadError(err)) return false;
      throw err;
    }
    if (!isCurrent() || workerForLoad !== worker) return false;
    currentLoadedLanguage = language;
  }

  if (!isCurrent()) return false;

  if (currentLoadedVoiceId !== voiceId) {
    if (!voiceData) throw new Error(`Missing voice data for ${language}:${voiceId}`);
    const workerForVoice = worker;
    if (!workerForVoice) throw new Error('Worker missing while loading voice');
    workerForVoice.postMessage({ type: 'load-voice', voiceId, voiceData, language });
    if (!isCurrent()) return false;
    try {
      await waitForWorkerMessage('voice-ready', 30000, workerForVoice, isCurrent);
    } catch (err) {
      if (isStaleLoadError(err)) return false;
      throw err;
    }
    if (!isCurrent() || workerForVoice !== worker) return false;
    currentLoadedVoiceId = voiceId;
  }

  return true;
}

function waitForWorkerMessage(expectedType, timeoutMs = 30000, workerInstance = worker, isCurrent = () => true) {
  return new Promise((resolve, reject) => {
    const targetWorker = workerInstance;
    if (!targetWorker) {
      reject(new Error(`Worker missing while waiting for worker message: ${expectedType}`));
      return;
    }

    let settled = false;
    let timer = null;
    let staleCheckTimer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (staleCheckTimer) clearInterval(staleCheckTimer);
      targetWorker.removeEventListener('message', handler);
    };

    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const currentCheck = () => {
      try {
        return isCurrent();
      } catch (_) {
        return false;
      }
    };

    const finishStale = () => {
      const err = new Error(`Stale worker wait while waiting for worker message: ${expectedType}`);
      err.name = 'StaleWorkerWait';
      finishReject(err);
    };

    function handler(e) {
      if (!currentCheck()) {
        finishStale();
        return;
      }
      if (e.data.type === expectedType) {
        finishResolve(e.data);
      } else if (e.data.type === 'error') {
        finishReject(new Error(e.data.error || 'Worker error during ' + expectedType));
      }
    }

    if (!currentCheck()) {
      finishStale();
      return;
    }

    targetWorker.addEventListener('message', handler);
    timer = setTimeout(() => {
      finishReject(new Error(`Timeout waiting for worker message: ${expectedType}`));
    }, timeoutMs);
    staleCheckTimer = setInterval(() => {
      if (!currentCheck()) finishStale();
    }, 50);
  });
}

function handleWorkerMessage(msg) {
  if (msg.type === 'diag') {
    console.log('[Worker]', msg.message);
    sendToServiceWorker({ type: 'diag', message: msg.message });
    return;
  }
  switch (msg.type) {
    case 'words': {
      if (msg.genId !== internalGenCounter) return;
      wordTimeline?.addEvents(msg.events);
      break;
    }
    case 'chunk': {
      if (msg.genId !== internalGenCounter) return;
      enqueueChunk(msg.data, msg.genId);
      checkBackpressure();
      break;
    }
    case 'done': {
      logToSW(`[Offscreen] Worker done for genId: ${msg.genId} (internal=${internalGenCounter})`);
      if (msg.genId !== internalGenCounter) return;
      generationDone = true;
      drainQueue();
      break;
    }
    case 'error': {
      if (msg.genId === undefined || msg.genId !== internalGenCounter) return;
      console.error('[Pocket Speechify] Worker error:', msg.error);
      internalGenCounter++;
      cancelGeneration(internalGenCounter - 1);
      sendToServiceWorker({
        type: 'tts-paragraph-done', genId: currentGenId, error: msg.error,
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

  // Future chunks will be stretched at the new speed.
  // Already-scheduled sources play at 1.0x with their already-stretched data.
  // No playbackRate changes needed — the stretching is baked into the audio data.
  logToSW(`[Offscreen] Speed changed to ${newSpeed}x (takes effect on next chunk)`);

  // Note: for already-buffered-but-not-yet-scheduled chunks in audioQueue,
  // they'll be stretched at the new speed when drainQueue processes them.
  // This gives near-instant speed changes for buffered audio.
}
