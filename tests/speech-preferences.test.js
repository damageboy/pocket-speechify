import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['mobile client hint', { userAgentData: { mobile: true, platform: '' } }, 'english_18m_2026-10'],
  ['Android tablet client hint', { userAgentData: { mobile: false, platform: 'Android' } }, 'english_18m_2026-10'],
  ['Android without client hints', { userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36' }, 'english_18m_2026-10'],
  ['iPhone', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' }, 'english_18m_2026-10'],
  ['desktop-mode iPad', { platform: 'MacIntel', maxTouchPoints: 5 }, 'english_18m_2026-10'],
  ['Mac', { userAgentData: { mobile: false, platform: 'macOS' }, platform: 'MacIntel', maxTouchPoints: 0 }, 'english'],
  ['touchscreen Windows laptop', { userAgentData: { mobile: false, platform: 'Windows' }, maxTouchPoints: 10 }, 'english'],
  ['unknown device', {}, 'english'],
])('chooses the default profile for %s without changing other languages', (_label, device, modelId) => {
  vi.stubGlobal('navigator', device);
  expect(preferences.normalizeSpeechProfile('english')).toEqual({ modelId, voiceId: 'alba', speed: 1 });
  expect(preferences.normalizeSpeechProfile('french')).toEqual({ modelId: 'french', voiceId: 'estelle', speed: 1 });
});

it('uses the native Android OS even with a desktop user agent and retains explicit model choices', async () => {
  vi.stubGlobal('navigator', { userAgentData: { mobile: false, platform: 'Linux' } });
  vi.stubGlobal('chrome', { runtime: { getPlatformInfo: async () => ({ os: 'android', arch: 'arm' }) } });
  expect(await store.get('english')).toEqual({ modelId: 'english_18m_2026-10', voiceId: 'alba', speed: 1 });
  expect(stored[en]).toBeUndefined(); // Reading a default must not create an explicit preference.
  expect(await store.update('english', { voiceId: 'vera', speed: 1.3 }))
    .toEqual({ modelId: 'english_18m_2026-10', voiceId: 'vera', speed: 1.3 });
  await store.update('english', { modelId: 'english_2026-09' });
  expect(await store.get('english')).toEqual({ modelId: 'english_2026-09', voiceId: 'vera', speed: 1.3 });
  stored[en].modelId = 'removed-model';
  expect(await store.get('english')).toEqual({ modelId: 'english_18m_2026-10', voiceId: 'vera', speed: 1.3 });
});

it.each(['current', 'legacy'])('preserves a %s saved desktop model on mobile', async source => {
  vi.stubGlobal('navigator', { userAgentData: { mobile: true, platform: 'Android' } });
  if (source === 'current') stored[en] = { modelId: 'english', voiceId: 'vera', speed: 1.6 };
  else stored['pocket-speechify-speech-selection'] = { selectedLanguage: 'english', voiceId: 'vera', speed: 1.6 };
  expect(await store.get('english')).toEqual({ modelId: 'english', voiceId: 'vera', speed: 1.6 });
});

it('falls back to browser hints when the native platform API fails', async () => {
  vi.stubGlobal('navigator', { userAgentData: { mobile: true, platform: 'Android' } });
  vi.stubGlobal('chrome', { runtime: { getPlatformInfo: async () => { throw new Error('Unavailable'); } } });
  expect((await store.get('english')).modelId).toBe('english_18m_2026-10');
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
