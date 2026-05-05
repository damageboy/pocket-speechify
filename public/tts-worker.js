// src/tts-worker.js
//
// WASM TTS worker — loads pocket-tts model and runs streaming inference.
// Based on babybirdprd/pocket-tts wasm-tts.worker.ts calling conventions.
//
// API: WasmTTSModel (load_from_buffer, load_voice_from_safetensors, start_stream)
//      WasmTTSStream (next_chunk_min_samples, last_chunk_stats)

let bindings = null; // cached WASM module
let model = null;
let sampleRate = 24000;
let cancelledGenId = -1;
let activeStreamToken = 0;
let generationPaused = false;

function diag(m) {
  console.log(m);
  self.postMessage({ type: 'diag', message: m });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --- Message handling ---

self.onmessage = async (e) => {
  const msg = e.data;

  switch (msg.type) {
    case 'load-model': {
      try {
        // Import WASM module (cached across calls)
        diag(`[TTS Worker] Importing WASM from: ${msg.wasmJsUrl}`);
        if (!bindings) {
          bindings = await import(msg.wasmJsUrl);
        }

        // Initialize WASM runtime
        diag('[TTS Worker] Initializing WASM runtime...');
        await bindings.default();

        // Create model
        diag('[TTS Worker] Creating WasmTTSModel...');
        model = new bindings.WasmTTSModel();

        // load_from_buffer(config_yaml, weights_data, tokenizer_bytes)
        // - config_yaml: REQUIRED — model architecture definition
        // - weights_data: safetensors language model weights
        // - tokenizer_bytes: REQUIRED — sentencepiece tokenizer for v2 language models
        const configBytes = new Uint8Array(msg.configData);
        const weightsBytes = new Uint8Array(msg.modelData);
        const tokenizerBytes = new Uint8Array(msg.tokenizerData);
        if (tokenizerBytes.byteLength === 0) {
          throw new Error('Tokenizer data is required for pocket-tts v2 language models');
        }

        diag(`[TTS Worker] Loading language=${msg.language}: config=${configBytes.byteLength}B, weights=${(weightsBytes.byteLength / 1024 / 1024).toFixed(1)}MB, tokenizer=${tokenizerBytes.byteLength}B`);
        model.load_from_buffer(configBytes, weightsBytes, tokenizerBytes);

        sampleRate = model.sample_rate;
        diag(`[TTS Worker] Model loaded. is_ready=${model.is_ready()}, sample_rate=${sampleRate}`);

        self.postMessage({ type: 'model-ready', sampleRate, language: msg.language });
      } catch (err) {
        diag(`[TTS Worker] load-model ERROR: ${err}`);
        self.postMessage({ type: 'error', error: String(err) });
      }
      break;
    }

    case 'load-voice': {
      try {
        diag(`[TTS Worker] Loading voice: ${msg.voiceId} (${msg.voiceData.byteLength}B)`);
        // Always reload — the WASM model stores a single voice state,
        // so loading a new voice replaces the previous one.
        model.load_voice_from_safetensors(new Uint8Array(msg.voiceData));
        diag(`[TTS Worker] Voice ${msg.voiceId} loaded`);
        self.postMessage({ type: 'voice-ready', voiceId: msg.voiceId });
      } catch (err) {
        diag(`[TTS Worker] load-voice ERROR: ${err}`);
        self.postMessage({ type: 'error', error: String(err) });
      }
      break;
    }

    case 'generate': {
      try {
        generationPaused = false;
        activeStreamToken++;
        await runGeneration(msg.genId, msg.text, activeStreamToken);
      } catch (err) {
        diag(`[TTS Worker] generate ERROR: ${err}`);
        self.postMessage({ type: 'error', genId: msg.genId, error: String(err) });
      }
      break;
    }

    case 'cancel': {
      cancelledGenId = Math.max(cancelledGenId, msg.genId);
      activeStreamToken++;
      break;
    }

    case 'pause-generation': {
      generationPaused = true;
      break;
    }

    case 'resume-generation': {
      generationPaused = false;
      break;
    }
  }
};

async function runGeneration(genId, text, streamToken) {
  if (genId <= cancelledGenId) return;
  if (!model || !model.is_ready()) {
    self.postMessage({ type: 'error', genId, error: 'Model not ready' });
    return;
  }

  diag(`[TTS Worker] Starting generation: genId=${genId}, text="${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);

  const stream = model.start_stream(text);
  diag(`[TTS Worker] Stream created`);

  let chunkCount = 0;

  // Adaptive chunk sizing (matching official implementation):
  // First 3 chunks: smaller for lower time-to-first-audio (~32ms = 768 samples)
  // After that: larger for efficiency (~110ms = 2640 samples)
  const startChunkSamples = Math.max(320, Math.floor(sampleRate * 0.032));
  const steadyChunkSamples = Math.max(1024, Math.floor(sampleRate * 0.11));

  while (streamToken === activeStreamToken) {
    if (genId <= cancelledGenId) {
      diag(`[TTS Worker] Cancelled at chunk ${chunkCount}`);
      return;
    }

    const targetSamples = chunkCount < 3 ? startChunkSamples : steadyChunkSamples;
    const chunk = stream.next_chunk_min_samples(targetSamples);

    if (!chunk) {
      diag(`[TTS Worker] Stream ended after ${chunkCount} chunks`);
      break;
    }

    if (chunkCount < 3) {
      diag(`[TTS Worker] Chunk ${chunkCount}: ${chunk.length} samples`);
    }

    self.postMessage(
      { type: 'chunk', genId, data: chunk },
      [chunk.buffer],
    );
    chunkCount++;

    // Yield to event loop every 6 chunks for cancellation + backpressure
    if (chunkCount % 6 === 0) {
      await sleep(0);
      // Wait while paused by backpressure (queue full)
      while (generationPaused && streamToken === activeStreamToken) {
        await sleep(50);
      }
    }
  }

  if (streamToken !== activeStreamToken) {
    diag(`[TTS Worker] Generation aborted`);
    return;
  }

  diag(`[TTS Worker] Generation complete: ${chunkCount} chunks`);
  self.postMessage({ type: 'done', genId });
}
