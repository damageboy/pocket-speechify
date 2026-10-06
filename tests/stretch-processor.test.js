// @vitest-environment node
import { expect, it } from 'vitest';
import ModuleFactory from '../public/lib/signalsmith-stretch/SignalsmithStretchModule.mjs';
import { createStretchProcessor } from '../src/stretch-processor.js';

it('exposes real WASM latency and flushes the audible tail at 1x', async () => {
  const processor = await createStretchProcessor(ModuleFactory, 24000, 1);
  expect(processor.inputLatency).toBeGreaterThan(0);
  expect(processor.outputLatency).toBeGreaterThan(0);
  const input = new Float32Array(24000);
  for (let i = 22000; i < input.length; i++) input[i] = 0.5 * Math.sin(i * 2 * Math.PI * 440 / 24000);
  const audio = processor.process(input, 1);
  const tail = processor.flush(1);
  expect(tail.map(chunk => chunk.inputSamples)).toEqual([processor.inputLatency, 0]);
  expect(tail.reduce((n, chunk) => n + chunk.data.length, 0)).toBe(processor.inputLatency + processor.outputLatency);
  const joined = Float32Array.from([...audio, ...tail.flatMap(chunk => [...chunk.data])]);
  // Without the flush, the last 2000 source samples would be discarded.
  const tailEnergy = joined.slice(24000).reduce((sum, x) => sum + x * x, 0);
  expect(tailEnergy).toBeGreaterThan(100);
  processor.reset();
  expect(processor.process(new Float32Array(24000), 1).every(x => Math.abs(x) < 1e-6)).toBe(true);
});
