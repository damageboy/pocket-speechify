// src/stretch-processor.js
//
// Direct WASM time-stretching processor — matches the Rust ssstretch::Stretch pattern.
// Calls the Signalsmith Stretch WASM _process(inputLen, outputLen) directly,
// producing time-stretched audio offline (not via AudioWorklet).
//
// Usage:
//   const proc = await createStretchProcessor(sampleRate, channels);
//   const stretched = proc.process(inputFloat32, speed);
//   // stretched is a Float32Array at original pitch, duration = input.length / speed

/**
 * Create a direct WASM stretch processor.
 * @param {Function} ModuleFactory - The raw Emscripten Module factory from SignalsmithStretchModule.mjs
 * @param {number} sampleRate - e.g. 24000
 * @param {number} channels - e.g. 1 (mono)
 * @returns {Promise<{process: Function, destroy: Function}>}
 */
export async function createStretchProcessor(ModuleFactory, sampleRate, channels) {
  const wasmModule = await ModuleFactory();
  wasmModule._main();
  wasmModule._presetDefault(channels, sampleRate);

  const inputLatency = wasmModule._inputLatency();
  const outputLatency = wasmModule._outputLatency();

  console.log(`[StretchProcessor] Initialized: sampleRate=${sampleRate}, channels=${channels}, inputLatency=${inputLatency}, outputLatency=${outputLatency}`);

  // We'll allocate buffers dynamically based on chunk size.
  // Track the current buffer allocation to avoid reallocating every call.
  let allocatedLen = 0;
  let bufferPointer = 0;
  let buffersIn = [];
  let buffersOut = [];

  function ensureBuffers(maxLen) {
    if (maxLen <= allocatedLen) return;
    // Allocate for the larger of input or output, with some headroom
    allocatedLen = Math.max(maxLen, 8192);
    bufferPointer = wasmModule._setBuffers(channels, allocatedLen);
    const lengthBytes = allocatedLen * 4; // Float32
    buffersIn = [];
    buffersOut = [];
    for (let c = 0; c < channels; c++) {
      buffersIn.push(bufferPointer + lengthBytes * c);
      buffersOut.push(bufferPointer + lengthBytes * (c + channels));
    }
  }

  /**
   * Time-stretch a mono audio chunk.
   * @param {Float32Array} input - Input audio samples
   * @param {number} speed - Playback speed (e.g. 2.0 = double speed, half duration)
   * @returns {Float32Array} - Stretched output (length ≈ input.length / speed)
   */
  function process(input, speed) {
    if (!input || input.length === 0) return new Float32Array(0);
    if (speed <= 0) speed = 1.0;

    const inputLen = input.length;
    const outputLen = Math.round(inputLen / speed);
    const maxLen = Math.max(inputLen, outputLen);

    ensureBuffers(maxLen);

    const memory = wasmModule.HEAP8.buffer;

    // Copy input into WASM input buffer (channel 0 for mono)
    for (let c = 0; c < channels; c++) {
      const wasmInput = new Float32Array(memory, buffersIn[c], inputLen);
      wasmInput.set(input);
    }

    // Process: inputLen input samples → outputLen output samples
    wasmModule._process(inputLen, outputLen);

    // Re-fetch memory in case it grew
    const memoryAfter = wasmModule.HEAP8.buffer;

    // Copy output from WASM output buffer
    const wasmOutput = new Float32Array(memoryAfter, buffersOut[0], outputLen);
    const result = new Float32Array(outputLen);
    result.set(wasmOutput);
    return result;
  }

  function reset() {
    // Clear all internal STFT delay-line / overlap-add state by re-running presetDefault.
    // Call this when starting a new generation to prevent audio bleed from previous audio.
    wasmModule._presetDefault(channels, sampleRate);
  }

  function destroy() {
    // WASM instance is GC'd with the closure — no explicit cleanup needed
  }

  return { process, reset, destroy };
}
