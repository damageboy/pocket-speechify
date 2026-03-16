// src/tts-worker.js
//
// WASM TTS worker — loads pocket-tts model and runs streaming inference.
// API: WasmTTSModel (load_from_buffer, load_voice_from_safetensors, start_stream)
//      WasmTTSStream (next_chunk)

let model = null;
let loadedVoices = new Map(); // voiceId → index
let cancelledGenId = -1;
let wasmInitialized = false;

// --- SentencePiece Unigram Tokenizer ---
// Vendored from LaurentMazare/xn's worker.js implementation.
// Parses .model protobuf and runs Viterbi decoding.
// Kept as a reference/fallback — babybirdprd's WASM API handles
// tokenization internally via start_stream(text).

let tokenizer = null;

class UnigramTokenizer {
  constructor(pieces) {
    this.pieces = pieces;
    this.pieceMap = new Map();
    for (let i = 0; i < pieces.length; i++) {
      this.pieceMap.set(pieces[i].piece, { index: i, score: pieces[i].score });
    }
  }

  encode(text) {
    const n = text.length;
    const best = new Array(n + 1).fill(null);
    best[0] = { score: 0, tokens: [] };

    for (let i = 0; i < n; i++) {
      if (best[i] === null) continue;
      for (let len = 1; len <= n - i && len <= 64; len++) {
        const substr = text.substring(i, i + len);
        const piece = this.pieceMap.get(substr);
        if (!piece) continue;
        const newScore = best[i].score + piece.score;
        if (best[i + len] === null || newScore > best[i + len].score) {
          best[i + len] = {
            score: newScore,
            tokens: [...best[i].tokens, piece.index],
          };
        }
      }
      // Unknown character fallback
      if (best[i + 1] === null) {
        best[i + 1] = {
          score: best[i].score - 100,
          tokens: [...best[i].tokens, 0],
        };
      }
    }

    return best[n] ? new Uint32Array(best[n].tokens) : new Uint32Array([]);
  }

  static async fromModelFile(buffer) {
    const bytes = new Uint8Array(buffer);
    const pieces = [];
    let pos = 0;

    while (pos < bytes.length) {
      const [fieldNum, wireType, newPos1] = readTag(bytes, pos);
      pos = newPos1;
      if (fieldNum === 1 && wireType === 2) {
        const [len, newPos2] = readVarint(bytes, pos);
        pos = newPos2;
        const pieceBytes = bytes.subarray(pos, pos + len);
        pos += len;
        const piece = parseSentencePiece(pieceBytes);
        pieces.push(piece);
      } else {
        pos = skipField(bytes, pos, wireType);
      }
    }

    return new UnigramTokenizer(pieces);
  }
}

function readVarint(bytes, pos) {
  let result = 0;
  let shift = 0;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

function readTag(bytes, pos) {
  const [tag, newPos] = readVarint(bytes, pos);
  return [tag >>> 3, tag & 0x07, newPos];
}

function skipField(bytes, pos, wireType) {
  switch (wireType) {
    case 0: { const [, p] = readVarint(bytes, pos); return p; }
    case 1: return pos + 8;
    case 2: { const [len, p] = readVarint(bytes, pos); return p + len; }
    case 5: return pos + 4;
    default: return bytes.length;
  }
}

function parseSentencePiece(bytes) {
  let piece = '';
  let score = 0;
  let pos = 0;
  while (pos < bytes.length) {
    const [fieldNum, wireType, newPos] = readTag(bytes, pos);
    pos = newPos;
    if (fieldNum === 1 && wireType === 2) {
      const [len, p] = readVarint(bytes, pos);
      pos = p;
      piece = new TextDecoder().decode(bytes.subarray(pos, pos + len));
      pos += len;
    } else if (fieldNum === 2 && wireType === 5) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4);
      score = view.getFloat32(0, true);
      pos += 4;
    } else {
      pos = skipField(bytes, pos, wireType);
    }
  }
  return { piece, score };
}

// --- Message handling ---

self.onmessage = async (e) => {
  const msg = e.data;

  switch (msg.type) {
    case 'load-model': {
      try {
        // Import and initialize WASM module
        const wasmModule = await import(chrome.runtime.getURL('wasm/pocket_tts.js'));
        await wasmModule.default();
        model = new wasmModule.WasmTTSModel();

        // Load model weights + tokenizer into WASM
        // load_from_buffer(config_yaml, weights_data, tokenizer_bytes)
        // Empty config = use defaults; tokenizer loaded from bundled file
        const tokResp = await fetch(chrome.runtime.getURL('tokenizer.model'));
        const tokBuffer = await tokResp.arrayBuffer();
        model.load_from_buffer(
          new Uint8Array([]),
          new Uint8Array(msg.modelData),
          new Uint8Array(tokBuffer),
        );

        // Also load JS tokenizer as reference (for potential xn API switch)
        tokenizer = await UnigramTokenizer.fromModelFile(tokBuffer);

        wasmInitialized = true;
        console.log('[TTS Worker] Model loaded, sample_rate:', model.sample_rate);
        self.postMessage({ type: 'model-ready' });
      } catch (err) {
        self.postMessage({ type: 'error', error: err.message });
      }
      break;
    }

    case 'load-voice': {
      try {
        if (!loadedVoices.has(msg.voiceId)) {
          model.load_voice_from_safetensors(new Uint8Array(msg.voiceData));
          loadedVoices.set(msg.voiceId, loadedVoices.size);
          console.log(`[TTS Worker] Voice ${msg.voiceId} loaded`);
        }
        self.postMessage({ type: 'voice-ready', voiceId: msg.voiceId });
      } catch (err) {
        self.postMessage({ type: 'error', error: err.message });
      }
      break;
    }

    case 'generate': {
      try {
        await runGeneration(msg.genId, msg.text, msg.voiceId);
      } catch (err) {
        self.postMessage({ type: 'error', genId: msg.genId, error: err.message });
      }
      break;
    }

    case 'cancel': {
      cancelledGenId = Math.max(cancelledGenId, msg.genId);
      break;
    }
  }
};

async function runGeneration(genId, text, voiceId) {
  if (genId <= cancelledGenId) return;

  // start_stream() handles tokenization internally via the tokenizer
  // loaded in load_from_buffer(). The JS UnigramTokenizer is kept as a
  // reference for potential future switch to xn's API.
  const stream = model.start_stream(text);

  while (true) {
    if (genId <= cancelledGenId) return;

    const chunk = stream.next_chunk();
    if (!chunk) break;

    if (genId <= cancelledGenId) return;

    self.postMessage(
      { type: 'chunk', genId, data: chunk },
      [chunk.buffer],
    );

    // Yield to event loop so cancel messages can be processed
    await new Promise((r) => setTimeout(r, 0));
  }

  if (genId <= cancelledGenId) return;
  self.postMessage({ type: 'done', genId });
}
