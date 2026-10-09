import { LANGUAGES, getLanguage, isSupportedLanguage } from './languages.js';

export function normalizeSpeechProfile(language, value = {}) {
  const models = LANGUAGES.filter(model => model.language === language);
  if (!models.length) throw new Error(`Unsupported speech language: ${language}`);
  const fallback = models.find(model => model.id === language) || models.find(model => model.status === 'production') || models[0];
  const model = models.find(model => model.id === value?.modelId) || fallback;
  return {
    modelId: model.id,
    voiceId: typeof value?.voiceId === 'string' && Object.hasOwn(model.voices, value.voiceId)
      ? value.voiceId : model.defaultVoice,
    speed: Number.isFinite(value?.speed) && value.speed >= 0.4 && value.speed <= 4.5 ? value.speed : 1,
  };
}

// Only the service worker creates this store. Reads and patches share a queue,
// so tab-local snapshots never overwrite another tab's unrelated settings.
export function createSpeechProfileStore(storage) {
  let pending = Promise.resolve();
  function enqueue(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  const keyFor = language => `pocket-speechify-speech-profile-v1:${language}`;
  const legacyKey = 'pocket-speechify-speech-selection';

  async function read(language) {
    const defaults = normalizeSpeechProfile(language);
    const key = keyFor(language);
    const values = await storage.get([key, legacyKey]);
    if (Object.hasOwn(values, key) && values[key] !== undefined) {
      return normalizeSpeechProfile(language, values[key]);
    }
    const legacy = values[legacyKey];
    if (isSupportedLanguage(legacy?.selectedLanguage) && getLanguage(legacy.selectedLanguage).language === language) {
      const profile = normalizeSpeechProfile(language, { ...legacy, modelId: legacy.selectedLanguage });
      await storage.set({ [key]: profile });
      return profile;
    }
    return defaults;
  }

  return {
    get: language => enqueue(() => read(language)),
    update: (language, patch) => enqueue(async () => {
      const current = await read(language);
      if (patch.modelId !== undefined && (!isSupportedLanguage(patch.modelId) || getLanguage(patch.modelId).language !== language)) {
        throw new Error('Model does not belong to the active language');
      }
      const profile = normalizeSpeechProfile(language, { ...current, ...patch });
      await storage.set({ [keyFor(language)]: profile });
      return profile;
    }),
  };
}
