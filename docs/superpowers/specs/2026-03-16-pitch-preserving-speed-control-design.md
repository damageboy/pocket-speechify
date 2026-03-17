# Pitch-Preserving Speed Control via Signalsmith Stretch

## Problem

The current speed control uses `AudioBufferSource.playbackRate`, which changes the sample playback rate. Speeding up raises pitch (chipmunk effect); slowing down lowers pitch. This is unacceptable for TTS.

## Solution

Replace `playbackRate`-based speed control with **Signalsmith Stretch**, a WASM-based time-stretching library that runs as an AudioWorklet. It changes playback rate while preserving pitch.

## Architecture

### Data Flow

```
Current:
  Worker → chunks → offscreen schedules AudioBufferSource nodes
           → source.playbackRate = speed (changes pitch!)
           → destination

New:
  Worker → chunks → offscreen calls stretchNode.addBuffers([chunk])
           → StretchNode (WASM AudioWorklet, rate=speed, pitch preserved)
           → destination
```

### Execution Context

All changes are in the **offscreen document** (offscreen.js). It has AudioContext, AudioWorklet, and extension-origin access. No changes to content script, service worker, or TTS worker.

### Vendored Library

Two files from `signalsmith-stretch/web/release/`, copied into `lib/signalsmith-stretch/`:

| File | Role |
|------|------|
| `SignalsmithStretch.mjs` | ES module for main thread (imported by offscreen.js). Contains inline WASM binary. |
| `SignalsmithStretch.js` | UMD version loaded into AudioWorklet scope via `audioWorklet.addModule()`. |

Chrome MV3 CSP forbids `blob:` in `script-src`, so we can't let the library create a blob URL for the worklet. Instead we set `SignalsmithStretch.moduleUrl` to a `chrome.runtime.getURL()` pointing at the static UMD file.

## Detailed Design

### StretchNode Lifecycle

- **Created once** per generation (new genId or new tab).
- **Persists across sentences** within the same generation — no buffer drop between sentences, so audio is seamless.
- **On cancel / new generation:** `stop()`, `dropBuffers()`, `disconnect()`, set to null.

```js
// Creation
stretchNode = await SignalsmithStretch(audioCtx, {
  numberOfInputs: 0,
  numberOfOutputs: 1,
  outputChannelCount: [1]  // mono, matching TTS output
});
stretchNode.connect(audioCtx.destination);
stretchNode.setUpdateInterval(0.05, onInputTimeUpdate);  // 50ms callback
stretchNode.start({rate: currentSpeed});
```

### Chunk Feeding

When a chunk arrives from the TTS worker:

```js
await stretchNode.addBuffers([float32Data]);  // mono = 1 channel
totalBufferedInputSec += float32Data.length / SAMPLE_RATE;
sentenceAudioSec += float32Data.length / SAMPLE_RATE;
```

No manual timeline scheduling, no `nextStartTime`, no `scheduledSources` array. The StretchNode consumes from its internal buffer at whatever rate is set.

### Speed Control

```js
function handleSetSpeed(newSpeed) {
  currentSpeed = newSpeed;
  if (stretchNode) {
    stretchNode.schedule({rate: newSpeed});  // takes effect within ~5ms
  }
}
```

No iterating over scheduled sources, no recalculating timelines.

### Pause / Resume

Unchanged: `AudioContext.suspend()` / `resume()` freezes/unfreezes the worklet.

### Backpressure

```js
function getBufferedAheadSec() {
  return Math.max(0, totalBufferedInputSec - (stretchNode?.inputTime || 0));
}
```

Same concept (tell worker to pause when >5s ahead), simpler measurement.

### Word Timing (Callback-Driven)

The StretchNode's `setUpdateInterval(0.05, callback)` fires every ~50ms with the current `inputTime` — the position in the input buffer that has actually been output as audio.

**State tracking:**
```js
let totalBufferedInputSec = 0;      // cumulative raw audio fed across all sentences
let sentenceStartInputSec = 0;      // where current sentence starts in the buffer
let sentenceAudioSec = 0;           // raw audio fed for current sentence
let sentenceGenerationDone = false;  // true when worker sends 'done'
let lastEmittedWordIdx = -1;        // prevent duplicate word events
```

**On each new sentence (continuing same generation):**
```js
sentenceStartInputSec = totalBufferedInputSec;
sentenceAudioSec = 0;
sentenceGenerationDone = false;
lastEmittedWordIdx = -1;
```

**The central callback:**
```js
function onInputTimeUpdate(inputTime) {
  if (paused || !currentSentenceMeta) return;

  const sentenceElapsed = inputTime - sentenceStartInputSec;

  // Word events via existing word-timing-estimator
  if (wordTimingEstimator) {
    const events = wordTimingEstimator.feedAudioDuration(sentenceElapsed);
    for (const evt of events) {
      if (evt.wordIndex > lastEmittedWordIdx) {
        lastEmittedWordIdx = evt.wordIndex;
        sendToServiceWorker({ type: 'tts-word', genId: currentGenId, detail: { ... } });
      }
    }
  }

  // Elapsed for progress ring
  sendToServiceWorker({ type: 'tts-elapsed', genId: currentGenId, elapsedSec: inputTime / currentSpeed });

  // Sentence-done detection
  if (sentenceGenerationDone && inputTime >= sentenceStartInputSec + sentenceAudioSec - 0.02) {
    // finalize remaining words, send tts-sentence-done
  }
}
```

**Speed changes require no recalculation.** The StretchNode changes how fast it advances through the buffer. Word thresholds are in raw input seconds, which don't change.

### Sentence-Done Detection

When worker sends `'done'`: set `sentenceGenerationDone = true`. The inputTime callback checks if playback has reached `sentenceStartInputSec + sentenceAudioSec`. When it has, fire `tts-sentence-done`. No polling loop needed.

### Duration & Elapsed Estimates

- `remote-tts.js` estimates total duration from word counts, divides by speed — unchanged.
- Elapsed: `inputTime / currentSpeed` — same approximation as before but from actual playback position.
- Speed-change-mid-playback inaccuracy remains (acceptable for progress indicator).

### Temporary Code

The `word-timing-estimator.js` module and proportional-character-length estimation are stopgaps. When pocket-tts adds native word-level timestamps:
- Timestamps come directly from chunk metadata.
- The `inputTime` callback pattern stays — it's the right architecture.
- Only the mapping from inputTime → word changes (lookup vs estimate).

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `lib/signalsmith-stretch/SignalsmithStretch.mjs` | Vendored ES module for main thread |
| `lib/signalsmith-stretch/SignalsmithStretch.js` | Vendored UMD for AudioWorklet scope |

### Modified Files

| File | Changes |
|------|---------|
| `manifest.json` | Add `lib/signalsmith-stretch/*.js` to `web_accessible_resources` |
| `offscreen.js` | Major rewrite of audio pipeline |

### offscreen.js — Removed

- `audioQueue[]`, `drainQueue()`, `startScheduler()`, `stopScheduler()`, `schedulerTimer`
- `scheduledSources[]`, `scheduleOneChunk()`, `nextStartTime`, `playbackStartTime`
- `pendingWordTimeouts[]`, `clearPendingWordEvents()`, all `setTimeout`-based word firing
- `timingCalibrationFactor`, `totalEstimatedSec`, `totalActualSec` calibration
- `workerWaiting` flag (concept stays, implementation simplified)

### offscreen.js — Added

- `import SignalsmithStretch` from vendored lib
- `stretchNode` — single AudioWorklet node, created per generation
- `totalBufferedInputSec`, `sentenceStartInputSec`, `sentenceGenerationDone`
- `onInputTimeUpdate(inputTime)` — central callback
- Simplified `handleSetSpeed()`, simplified backpressure

### Unchanged Files

| File | Reason |
|------|--------|
| `src/word-timing-estimator.js` | API fits — called from callback instead of scheduler |
| `src/remote-tts.js` | Duration estimates, setSpeed, sentence flow unchanged |
| `src/tts-worker.js` | Generates chunks, knows nothing about playback |
| `src/pill-player.js` | Speed UI dispatches same actions |
| `src/side-panels.js` | Speed panel dispatches same actions |
| `src/highlight.js` | Receives same word events |
| `src/state.js` | No changes |
| `service-worker.js` | Routes messages unchanged |
| `content.js` | No changes |
