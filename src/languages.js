import catalog from '../public/wasm/models.json' with { type: 'json' };

if (catalog.schemaVersion !== 1) {
  throw new Error(`Unsupported pocket-tts model catalog schema: ${catalog.schemaVersion}`);
}

export const DEFAULT_LANGUAGE_ID = catalog.defaultModel;

// Presentation and browser locale mapping belong to the extension; model
// definitions, defaults, asset URLs and configurations come from pocket-tts.
const LOCALES = {
  en: { language: 'english', flag: '🇬🇧' },
  de: { language: 'german', flag: '🇩🇪' },
  it: { language: 'italian', flag: '🇮🇹' },
  pt: { language: 'portuguese', flag: '🇧🇷' },
  es: { language: 'spanish', flag: '🇪🇸' },
  fr: { language: 'french', flag: '🇫🇷' },
  nl: { language: 'dutch', flag: '🇳🇱' },
};

export const LANGUAGES = catalog.models.map(model => ({
  ...model,
  flag: Object.values(LOCALES).find(locale => locale.language === model.language)?.flag || '🌍',
}));

const LANGUAGE_BY_ID = Object.fromEntries(LANGUAGES.map(model => [model.id, model]));

export function getLanguage(languageId) {
  return LANGUAGE_BY_ID[languageId] || LANGUAGE_BY_ID[DEFAULT_LANGUAGE_ID];
}

export function isSupportedLanguage(languageId) {
  return Object.hasOwn(LANGUAGE_BY_ID, languageId);
}

export function getDefaultVoiceForLanguage(languageId) {
  return getLanguage(languageId).defaultVoice;
}

export function languageFlag(languageId) {
  return getLanguage(languageId).flag;
}

export function languageFromLocale(locale) {
  if (!locale || typeof locale !== 'string') return null;
  const primary = locale.trim().toLowerCase().replace('_', '-').split('-')[0];
  const language = LOCALES[primary]?.language;
  return LANGUAGES.some(model => model.language === language) ? language : null;
}

// Include the complete pinned URL, not just a language/path. This also versions
// the resumable downloader's .partial and .partial-meta keys automatically.
export function getModelCacheKey(languageId) {
  return encodeURIComponent(getModelUrl(languageId));
}

export function getTokenizerCacheKey(languageId) {
  return encodeURIComponent(getTokenizerUrl(languageId));
}

export function getVoiceCacheKey(languageId, voiceId) {
  return encodeURIComponent(getVoiceUrl(languageId, voiceId));
}

export function getModelUrl(languageId) {
  return getLanguage(languageId).weightsUrl;
}

export function getTokenizerUrl(languageId) {
  return getLanguage(languageId).tokenizerUrl;
}

export function getVoiceUrl(languageId, voiceId) {
  const url = getLanguage(languageId).voices[voiceId];
  if (!url) throw new Error(`Voice ${voiceId} is unavailable for model ${languageId}`);
  return url;
}

export function buildLanguageConfigYaml(languageId) {
  return getLanguage(languageId).configYaml;
}
