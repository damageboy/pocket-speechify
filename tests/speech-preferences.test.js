import { beforeEach, expect, it } from 'vitest';
import * as preferences from '../src/speech-preferences.js';

let stored, store;
const en = 'pocket-speechify-speech-profile-v1:english';
const fr = 'pocket-speechify-speech-profile-v1:french';
beforeEach(() => {
  stored = {};
  store = preferences.createSpeechProfileStore({
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(stored[key])]));
    },
    async set(values) { Object.assign(stored, structuredClone(values)); },
  });
});

it('merges concurrent field edits without crossing languages or losing fields', async () => {
  await Promise.all([
    store.update('english', { modelId: 'english_2026-09', speed: 1.7 }),
    store.update('french', { modelId: 'french_24l', voiceId: 'marius', speed: 0.8 }),
    store.update('english', { voiceId: 'vera' }),
    store.update('french', { speed: 1.2 }),
  ]);
  expect(stored[en]).toEqual({ modelId: 'english_2026-09', voiceId: 'vera', speed: 1.7 });
  expect(stored[fr]).toEqual({ modelId: 'french_24l', voiceId: 'marius', speed: 1.2 });
});

it('migrates the legacy tuple only into its own language and never overwrites a profile', async () => {
  stored['pocket-speechify-speech-selection'] = { selectedLanguage: 'french_24l', voiceId: 'marius', speed: 1.3 };
  expect(await store.get('english')).toEqual({ modelId: 'english', voiceId: 'alba', speed: 1 });
  expect(stored[en]).toBeUndefined();
  expect(await store.get('french')).toEqual({ modelId: 'french_24l', voiceId: 'marius', speed: 1.3 });
  await store.update('french', { speed: 0.7 });
  expect((await store.get('french')).speed).toBe(0.7);
});

it('normalizes foreign/removed models, invalid voices and speeds independently', async () => {
  stored[fr] = { modelId: 'english_2026-09', voiceId: 'removed', speed: 1.4 };
  expect(await store.get('french')).toEqual({ modelId: 'french', voiceId: 'estelle', speed: 1.4 });
  stored[en] = { modelId: 'english_2026-09', voiceId: 'vera', speed: 4.6 };
  expect(await store.get('english')).toEqual({ modelId: 'english_2026-09', voiceId: 'vera', speed: 1 });
  await expect(store.update('french', { modelId: 'english' })).rejects.toThrow();
});

it('keeps compatible voice and speed when changing models', async () => {
  await store.update('english', { voiceId: 'vera', speed: 1.8 });
  expect(await store.update('english', { modelId: 'english_2026-09' }))
    .toEqual({ modelId: 'english_2026-09', voiceId: 'vera', speed: 1.8 });
});

it('recovers its queue after a failed write', async () => {
  let fail = true;
  store = preferences.createSpeechProfileStore({
    async get() { return {}; },
    async set() { if (fail) throw new Error('disk full'); },
  });
  await expect(store.update('english', { speed: 1.2 })).rejects.toThrow('disk full');
  fail = false;
  expect((await store.update('french', { speed: 0.9 })).speed).toBe(0.9);
});
