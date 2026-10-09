import { describe, expect, it, vi } from 'vitest';

const { catalog } = vi.hoisted(() => ({
  catalog: {
    schemaVersion: 1,
    sourceRevision: 'fixture',
    defaultModel: 'english_future',
    voices: [{ id: 'new_voice', language: 'english', gender: 'f', style: 'reading' }],
    models: [{
      id: 'english_future', language: 'english', description: 'Future English',
      defaultVoice: 'new_voice', layers: 12, status: 'preview',
      configYaml: 'default_temperature: 0.42\nflow_lm:\n  sampler: {type: new-sampler}\n',
      weightsUrl: 'https://huggingface.co/org/models/resolve/weights-a/new.safetensors',
      tokenizerUrl: 'https://huggingface.co/org/tokenizers/resolve/tokenizer-b/new.json',
      voices: { new_voice: 'https://huggingface.co/org/voices/resolve/voice-c/future/new_voice.safetensors' },
    }],
  },
}));

vi.mock('../public/wasm/models.json', () => ({ default: catalog }));

describe('upstream model catalog consumption', () => {
  it('detects a supported base language even when all its models have variant IDs', async () => {
    const { languageFromLocale } = await import('../src/languages.js');
    const { normalizeSpeechProfile } = await import('../src/speech-preferences.js');
    expect(languageFromLocale('en-GB')).toBe('english');
    expect(normalizeSpeechProfile('english')).toEqual({ modelId: 'english_future', voiceId: 'new_voice', speed: 1 });
  });

  it('accepts new models, defaults, voices, configs and separate asset pins without extension edits', async () => {
    const languages = await import('../src/languages.js');
    const voices = await import('../src/voices.js');
    expect(languages.DEFAULT_LANGUAGE_ID).toBe('english_future');
    expect(languages.LANGUAGES.map(model => model.id)).toEqual(['english_future']);
    expect(languages.getLanguage('english_future')).toMatchObject({ description: 'Future English', layers: 12, flag: '🇬🇧' });
    expect(languages.getDefaultVoiceForLanguage('english_future')).toBe('new_voice');
    expect(languages.buildLanguageConfigYaml('english_future')).toBe('default_temperature: 0.42\nflow_lm:\n  sampler: {type: new-sampler}\n');
    expect(languages.getModelUrl('english_future')).toBe('https://huggingface.co/org/models/resolve/weights-a/new.safetensors');
    expect(languages.getTokenizerUrl('english_future')).toBe('https://huggingface.co/org/tokenizers/resolve/tokenizer-b/new.json');
    expect(languages.getVoiceUrl('english_future', 'new_voice')).toBe('https://huggingface.co/org/voices/resolve/voice-c/future/new_voice.safetensors');
    expect(voices.VOICES).toEqual([{ id: 'new_voice', name: 'New Voice', lang: 'english', gender: 'f', style: 'reading', hasAvatar: false }]);
    expect(voices.DEFAULT_VOICE_ID).toBe('new_voice');
  });

  it('invalidates complete and partial cache keys when URLs change, even with the same model ID', async () => {
    const first = await import('../src/languages.js');
    const oldKeys = [first.getModelCacheKey('english_future'), first.getTokenizerCacheKey('english_future'), first.getVoiceCacheKey('english_future', 'new_voice')];
    catalog.models[0].weightsUrl = 'https://huggingface.co/org/models/resolve/weights-b/new.safetensors';
    catalog.models[0].tokenizerUrl = 'https://huggingface.co/org/tokenizers/resolve/tokenizer-c/new.json';
    catalog.models[0].voices.new_voice = 'https://huggingface.co/org/voices/resolve/voice-d/future/new_voice.safetensors';
    vi.resetModules();
    const next = await import('../src/languages.js');
    const newKeys = [next.getModelCacheKey('english_future'), next.getTokenizerCacheKey('english_future'), next.getVoiceCacheKey('english_future', 'new_voice')];
    for (let i = 0; i < oldKeys.length; i++) {
      expect(newKeys[i]).not.toBe(oldKeys[i]);
      expect(newKeys[i] + '.partial').not.toBe(oldKeys[i] + '.partial');
    }
  });
});
