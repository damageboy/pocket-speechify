// offscreen.js
import { createWordTimeline } from '../../src/word-timeline.js';
import { createStretchProcessor } from '../../src/stretch-processor.js';
import { preprocessText } from '../../src/text-rules.js';
import { normalizeVolumeSettings } from '../../src/speech-preferences.js';
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
let volumeGain = null;
let currentVolume = 1;
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
    volumeGain = audioCtx.createGain();
    volumeGain.gain.value = currentVolume;
    volumeGain.connect(audioCtx.destination);
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

function updateKeepAwake() {
  // Offscreen owns playback identity, but only the service worker can use power.
  sendToServiceWorker({ type: 'tts-keep-awake', active: Boolean(playbackOwner && !paused) });
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
//
// Downloads are single-flight per cache key, and the partial body is the only
// resume state: its byte length is the resume offset. A separate length record
// can be torn from the body by a crash or a concurrent writer, which corrupts
// the asset or permanently stalls every later resume.

const inFlightDownloads = new Map(); // cacheKey -> { promise, waiters: Set<owner> }
let cacheEpoch = 0;

function parseContentRange(resp) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec((resp.headers.get('content-range') || '').trim());
  if (!match) return null;
  return { start: Number(match[1]), total: match[3] === '*' ? null : Number(match[3]) };
}

async function openDownload(url, startByte) {
  const headers = {};
  if (startByte > 0) headers['Range'] = `bytes=${startByte}-`;
  return fetch(url, { headers });
}

async function downloadWithProgress({ url, cacheKey, asset, voiceId, language, flight, epoch }) {
  const partialKey = `${cacheKey}.partial`;
  const broadcast = (msg) => {
    for (const waiter of flight.waiters) sendToServiceWorker(msg, waiter);
  };

  const existing = await getCached(partialKey);
  let startByte = existing ? existing.byteLength : 0;
  let resp = await openDownload(url, startByte);

  // A stored partial can be unusable (the server lost the file, or a previous
  // attempt left bytes the server will not range over). Restart once from zero.
  const storedRange = parseContentRange(resp);
  if (resp.status === 416 || (resp.status === 206 && storedRange && storedRange.start !== startByte)) {
    await deleteCache(partialKey);
    startByte = 0;
    resp = await openDownload(url, 0);
    const restartedRange = parseContentRange(resp);
    if (resp.status === 416 || (resp.status === 206 && restartedRange && restartedRange.start !== 0)) {
      throw new Error(`Download failed: cannot resume ${url}`);
    }
  }
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  }

  // A server may ignore Range and return the entire file. Never prepend the prefix.
  if (resp.status === 200) startByte = 0;

  const totalBytes = parseContentRange(resp)?.total ??
    startByte + parseInt(resp.headers.get('content-length') || '0', 10);
  const chunks = startByte > 0 && existing ? [new Uint8Array(existing)] : [];
  let received = startByte;
  const reader = resp.body.getReader();

  let lastCheckpointBucket = -1;
  let lastProgressBucket = -1;

  const writePartial = async () => {
    if (cacheEpoch !== epoch) return;
    await putCache(partialKey, mergeChunks(chunks, received).buffer);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const percent = totalBytes > 0 ? Math.round((received / totalBytes) * 100) : -1;

      const progressBucket = Math.floor(percent / 2);
      if (progressBucket > lastProgressBucket) {
        lastProgressBucket = progressBucket;
        broadcast({ type: 'download-progress', asset, voiceId, language, percent });
      }

      const checkpointBucket = Math.floor(percent / 10);
      if (checkpointBucket > lastCheckpointBucket) {
        lastCheckpointBucket = checkpointBucket;
        await writePartial();
        logToSW(`[Offscreen] Checkpoint at ${percent}% (${(received / 1024 / 1024).toFixed(1)}MB)`);
      }
    }
  } catch (err) {
    await writePartial().catch(() => {});
    logToSW(`[Offscreen] Download interrupted at ${(received / 1024 / 1024).toFixed(1)}MB. Will resume.`);
    throw err;
  }

  if (totalBytes > 0 && received !== totalBytes) {
    await writePartial().catch(() => {});
    throw new Error(`Download incomplete: ${received}/${totalBytes} bytes`);
  }
  if (cacheEpoch !== epoch) throw new Error('Cache cleared during download');

  const fullBuffer = mergeChunks(chunks, received);
  await putCache(cacheKey, fullBuffer.buffer);
  await deleteCache(partialKey);
  logToSW(`[Offscreen] ${asset}${voiceId ? ':' + voiceId : ''}${language ? ` (${language})` : ''} cached (${(received / 1024 / 1024).toFixed(1)}MB)`);
  broadcast({ type: 'download-complete', asset, voiceId, language });
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
  source.connect(volumeGain);

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
    volumeGain = null;
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

function cancelPlayback(genId) {
  internalGenCounter++;
  activeLoadToken++;
  cancelGeneration(internalGenCounter - 1);
  if (genId !== undefined) currentGenId = genId;
  playbackOwner = null;
  updateKeepAwake();
}

// --- Message handling ---

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type || msg.source !== 'service-worker') return;
  logToSW(`[Offscreen] Received: ${msg.type}`);
  if (['tts-pause', 'tts-resume', 'tts-cancel', 'tts-set-speed', 'tts-set-volume'].includes(msg.type) && !isOwner(msg)) return;

  switch (msg.type) {
    case 'tts-play-paragraph':
      handlePlayParagraph(msg).catch(err => {
        console.error('[Offscreen] handlePlayParagraph error:', err);
        if (isOwner(msg)) cancelPlayback();
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
      cancelPlayback(msg.genId);
      break;
    case 'tts-cancel-tab':
      // The tab that owned playback was closed, discarded, or navigated away.
      if (playbackOwner?.tabId === msg.tabId) cancelPlayback();
      break;
    case 'tts-set-speed':
      handleSetSpeed(msg.speed);
      break;
    case 'tts-set-volume':
      currentVolume = normalizeVolumeSettings({ volume: msg.volume }).volume;
      if (volumeGain) {
        // Smooth live changes to avoid clicks, including on already-scheduled audio.
        volumeGain.gain.cancelScheduledValues(audioCtx.currentTime);
        volumeGain.gain.setTargetAtTime(currentVolume, audioCtx.currentTime, 0.01);
      }
      break;
    case 'tts-clear-cache': {
      // In-flight downloads check this epoch before writing, so a clear is not
      // silently undone by a download that finishes after it.
      cacheEpoch++;
      const clearLoadToken = ++activeLoadToken;
      caches.delete(CACHE_NAME).then(deleted => {
        if (clearLoadToken !== activeLoadToken) return;
        logToSW(`[Offscreen] Cache cleared: ${deleted}`);
        if (worker) {
          rejectWorkerRequests(worker, new Error('TTS worker terminated by cache clear'));
          worker.terminate();
          worker = null;
        }
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

  let flight = inFlightDownloads.get(cacheKey);
  if (!flight) {
    logToSW(`[Offscreen] ${asset}${voiceId ? ':' + voiceId : ''} (${language}) not cached, downloading...`);
    flight = { waiters: new Set() };
    flight.promise = downloadWithProgress({
      url, cacheKey, asset, voiceId, language, flight, epoch: cacheEpoch,
    }).finally(() => {
      if (inFlightDownloads.get(cacheKey) === flight) inFlightDownloads.delete(cacheKey);
    });
    // A superseded flight can settle with no waiter left to observe it.
    flight.promise.catch(() => {});
    inFlightDownloads.set(cacheKey, flight);
  }

  flight.waiters.add(owner);
  try {
    const downloadedData = await flight.promise;
    logToSW(`[Offscreen] ${asset}${voiceId ? ':' + voiceId : ''} (${language}) download complete`);
    return downloadedData;
  } finally {
    flight.waiters.delete(owner);
  }
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
    textRules,
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
  currentVolume = normalizeVolumeSettings({ volume: msg.volume }).volume;
  const myInternalGen = internalGenCounter;
  const myLoadToken = ++activeLoadToken;
  if (isNewGeneration) paused = false;
  updateKeepAwake();

  // Seek in original page coordinates before applying the rules supplied by the service worker.
  const pageWords = [...paragraphText.matchAll(/\S+/g)];
  const startOffset = pageWords[startParaWordOffset]?.index ?? paragraphText.length;
  const sourceText = paragraphText.slice(startOffset);
  const processed = preprocessText(sourceText, textRules);
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

  if (!isCurrent()) return false;

  const mustLoadModel = !worker || currentLoadedLanguage !== language;

  if (mustLoadModel) {
    if (!modelAssets) throw new Error(`Missing model assets for language ${language}`);
    const { modelData, tokenizerData, configData } = modelAssets;
    if (!isCurrent()) return false;
    if (worker) {
      rejectWorkerRequests(worker, new Error('TTS worker replaced'));
      worker.terminate();
      worker = null;
    }
    currentLoadedVoiceId = null;
    currentLoadedLanguage = null;
    const workerInstance = new Worker(browser.runtime.getURL('tts-worker.js'));
    worker = workerInstance;
    workerInstance.onmessage = (e) => handleWorkerMessage(e.data);
    workerInstance.onerror = (e) => {
      const location = e.filename ? ` at ${e.filename}:${e.lineno}` : '';
      handleWorkerFailure(workerInstance, `${e.message || 'unknown worker error'}${location}`);
    };
    const wasmJsUrl = browser.runtime.getURL('wasm/pocket_tts.js');
    const timestamps = /^timestamp_heads:\s*\[/m.test(buildLanguageConfigYaml(language));
    if (!timestamps) logToSW(`[Offscreen] ${language} has no calibrated timestamp heads; playing without word highlights`);
    const workerForLoad = workerInstance;
    await requestFromWorker(workerForLoad, {
      type: 'load-model', modelData, tokenizerData, configData, wasmJsUrl, language, timestamps,
    }, { transfer: [modelData, tokenizerData, configData] });
    if (!isCurrent() || workerForLoad !== worker) return false;
    currentLoadedLanguage = language;
  }

  if (!isCurrent()) return false;

  if (currentLoadedVoiceId !== voiceId) {
    if (!voiceData) throw new Error(`Missing voice data for ${language}:${voiceId}`);
    const workerForVoice = worker;
    if (!workerForVoice) throw new Error('Worker missing while loading voice');
    await requestFromWorker(workerForVoice, { type: 'load-voice', voiceId, voiceData, language });
    if (!isCurrent() || workerForVoice !== worker) return false;
    currentLoadedVoiceId = voiceId;
  }

  return true;
}

// --- Worker request/response dispatcher ---
//
// Load requests are correlated by a request ID echoed from the worker, so an
// overlapping reply or a stale generation's error cannot settle the wrong
// request. A worker failure rejects every pending request immediately instead
// of leaving callers to sit out their timeout.

let nextWorkerRequestId = 1;
const pendingWorkerRequests = new Map(); // requestId -> { worker, resolve, reject, timer }

function requestFromWorker(workerInstance, message, { timeoutMs = 30000, transfer = [] } = {}) {
  const requestId = nextWorkerRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingWorkerRequests.delete(requestId);
      reject(new Error(`TTS worker did not respond to ${message.type} within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pendingWorkerRequests.set(requestId, { worker: workerInstance, resolve, reject, timer });
    workerInstance.postMessage({ ...message, requestId }, transfer);
  });
}

function settleWorkerRequest(msg) {
  const request = pendingWorkerRequests.get(msg.requestId);
  if (!request) return false;
  pendingWorkerRequests.delete(msg.requestId);
  clearTimeout(request.timer);
  if (msg.type === 'error') request.reject(new Error(msg.error || 'TTS worker request failed'));
  else request.resolve(msg);
  return true;
}

function rejectWorkerRequests(workerInstance, error) {
  for (const [requestId, request] of pendingWorkerRequests) {
    if (request.worker !== workerInstance) continue;
    pendingWorkerRequests.delete(requestId);
    clearTimeout(request.timer);
    request.reject(error);
  }
}

function handleWorkerFailure(workerInstance, message) {
  const error = new Error(`TTS worker failed: ${message}`);
  logToSW(`[Offscreen] WORKER FAILURE: ${message}`);
  rejectWorkerRequests(workerInstance, error);
  try { workerInstance.terminate(); } catch (_) {}
  if (workerInstance !== worker) return;
  worker = null;
  currentLoadedVoiceId = null;
  currentLoadedLanguage = null;
  // A generation has no pending request to reject, so surface it directly.
  if (paragraphDoneResolve) {
    const owner = playbackOwner;
    cancelPlayback();
    if (owner) {
      sendToServiceWorker({
        type: 'tts-paragraph-done', genId: currentGenId, error: error.message, fatal: true,
      }, owner);
    }
  }
}

function handleWorkerMessage(msg) {
  if (msg.type === 'diag') {
    console.log('[Worker]', msg.message);
    sendToServiceWorker({ type: 'diag', message: msg.message });
    return;
  }
  // Load replies carry the request ID they answer; generation messages do not.
  if (msg.requestId !== undefined && settleWorkerRequest(msg)) return;
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
  updateKeepAwake();
  stopScheduler();
  getAudioContext().suspend();
}

function handleResume() {
  paused = false;
  updateKeepAwake();
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
