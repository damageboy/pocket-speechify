import { beforeEach, expect, it, vi } from 'vitest';
import { detectMetadataLanguage, getSiteLanguageKey, resolvePageLanguage } from '../src/language-detection.js';

beforeEach(() => {
  document.head.replaceChildren();
  document.documentElement.removeAttribute('lang');
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(async () => ({ isReliable: false, languages: [] })) },
    storage: { local: { get: vi.fn(async () => ({})) } },
  });
});

it('normalizes regions and keeps metadata priority', () => {
  document.documentElement.lang = 'fr-CA';
  document.head.innerHTML = '<meta property="og:locale" content="en_US">';
  expect(detectMetadataLanguage(document)).toEqual({ language: 'french', raw: 'fr-CA' });
  document.documentElement.removeAttribute('lang');
  expect(detectMetadataLanguage(document).language).toBe('english');
});

it('uses confident article text instead of misleading metadata or old preferences', async () => {
  document.documentElement.lang = 'en-US';
  chrome.storage.local.get.mockResolvedValue({
    'pocket-speechify-speech-selection': { selectedLanguage: 'german' },
    'pocket-speechify-language-overrides': { 'example.com': 'spanish' },
  });
  chrome.runtime.sendMessage.mockResolvedValue({ isReliable: true, languages: [{ language: 'fr', percentage: 92 }, { language: 'en', percentage: 8 }] });
  expect(await resolvePageLanguage('https://example.com', document, 'Bonjour. '.repeat(100)))
    .toMatchObject({ activeLanguage: 'french', detectedLanguage: 'french', languageSource: 'text' });
});

it.each([
  { isReliable: false, languages: [{ language: 'fr', percentage: 100 }] },
  { isReliable: true, languages: [{ language: 'fr', percentage: 79 }, { language: 'en', percentage: 21 }] },
])('uses metadata for uncertain or mixed detection: %j', async result => {
  document.documentElement.lang = 'de-DE';
  chrome.runtime.sendMessage.mockResolvedValue(result);
  expect(await resolvePageLanguage('https://example.com', document, 'Some content'))
    .toMatchObject({ activeLanguage: 'german', languageSource: 'metadata' });
});

it('reports unsupported dominant text rather than claiming English was detected', async () => {
  document.documentElement.lang = 'en';
  chrome.runtime.sendMessage.mockResolvedValue({ isReliable: true, languages: [{ language: 'ja', percentage: 100 }] });
  expect(await resolvePageLanguage('https://example.com', document, '日本語の記事'))
    .toMatchObject({ activeLanguage: 'english', detectedLanguage: null, unsupportedLocale: 'ja', languageSource: 'fallback' });
});

it('uses legacy site choice only when detection is unavailable', async () => {
  chrome.storage.local.get.mockResolvedValue({ 'pocket-speechify-language-overrides': { 'example.com': 'french_24l' } });
  expect(await resolvePageLanguage('https://news.example.com', document)).toMatchObject({ activeLanguage: 'french', languageSource: 'override' });
  document.documentElement.lang = 'it-IT';
  expect(await resolvePageLanguage('https://news.example.com', document)).toMatchObject({ activeLanguage: 'italian', languageSource: 'metadata' });
});

it('falls back safely on unavailable APIs and missing metadata', async () => {
  chrome.runtime.sendMessage.mockRejectedValue(new Error('worker unavailable'));
  chrome.storage.local.get.mockRejectedValue(new Error('storage unavailable'));
  expect(await resolvePageLanguage(null, null, 'Hello')).toMatchObject({ activeLanguage: 'english', languageSource: 'fallback' });
  document.documentElement.lang = 'fr';
  expect(await resolvePageLanguage(null, document, 'Bonjour')).toMatchObject({ activeLanguage: 'french', languageSource: 'metadata' });
});

it('bounds text sent for detection and does not send it to an audio context', async () => {
  await resolvePageLanguage(null, document, 'x'.repeat(30000));
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'speech-detect-language', text: 'x'.repeat(12000) });
});

it('uses registrable site keys including private domains', () => {
  expect(getSiteLanguageKey('news.example.co.uk')).toBe('example.co.uk');
  expect(getSiteLanguageKey('foo.github.io')).toBe('foo.github.io');
  expect(getSiteLanguageKey('localhost')).toBe('localhost');
});
