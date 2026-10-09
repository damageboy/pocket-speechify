import { getDomain } from 'tldts';
import { DEFAULT_LANGUAGE_ID, getLanguage, isSupportedLanguage, languageFromLocale } from './languages.js';

const LANGUAGE_OVERRIDES_KEY = 'pocket-speechify-language-overrides';

export function getSiteLanguageKey(hostname) {
  const host = String(hostname || '').toLowerCase();
  return getDomain(host, { allowPrivateDomains: true }) || host;
}

function metadataCandidates(doc) {
  const meta = selector => doc?.querySelector?.(selector)?.getAttribute('content')?.trim() || '';
  return [
    doc?.documentElement?.getAttribute?.('lang') || '',
    meta('meta[property="og:locale"]'),
    meta('meta[http-equiv="content-language" i]'),
    meta('meta[name="language" i]'),
  ];
}

export function detectMetadataLanguage(doc = globalThis.document) {
  for (const raw of metadataCandidates(doc)) {
    const language = languageFromLocale(raw);
    if (language) return { language, raw };
  }
  return null;
}

export async function resolvePageLanguage(url, doc = globalThis.document, text = '') {
  let hostname = '';
  try { hostname = new URL(url || globalThis.location?.href).hostname; } catch { /* No site fallback. */ }
  const siteKey = getSiteLanguageKey(hostname);
  const fallback = {
    siteKey,
    activeLanguage: getLanguage(DEFAULT_LANGUAGE_ID).language,
    detectedLanguage: null,
    unsupportedLocale: null,
    languageSource: 'fallback',
  };

  if (text.trim()) {
    try {
      const result = await globalThis.chrome?.runtime?.sendMessage({ type: 'speech-detect-language', text: text.slice(0, 12000) });
      const dominant = result?.languages?.find(candidate => candidate.percentage >= 80 && candidate.language !== 'und');
      if (result?.isReliable && dominant) {
        const language = languageFromLocale(dominant.language);
        if (!language) return { ...fallback, unsupportedLocale: dominant.language };
        return { ...fallback, activeLanguage: language, detectedLanguage: language, languageSource: 'text' };
      }
    } catch (error) {
      console.warn('[Pocket Speechify] Text language detection unavailable:', error);
    }
  }

  const detected = detectMetadataLanguage(doc);
  if (detected) {
    return { ...fallback, activeLanguage: detected.language, detectedLanguage: detected.language, languageSource: 'metadata' };
  }

  try {
    const stored = await globalThis.chrome?.storage?.local?.get(LANGUAGE_OVERRIDES_KEY);
    const override = stored?.[LANGUAGE_OVERRIDES_KEY]?.[siteKey];
    if (isSupportedLanguage(override)) {
      return { ...fallback, activeLanguage: getLanguage(override).language, languageSource: 'override' };
    }
  } catch (error) {
    console.warn('[Pocket Speechify] Site language fallback unavailable:', error);
  }
  return { ...fallback, unsupportedLocale: metadataCandidates(doc).find(raw => raw && raw !== 'und') || null };
}
