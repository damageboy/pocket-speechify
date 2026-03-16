// src/voices.js

/**
 * Pocket-tts voice definitions.
 * Voice IDs match the safetensors filenames on HuggingFace.
 * Gender from https://kyutai.github.io/pocket-tts/ voice metadata.
 */
export const VOICES = [
  { id: 'alba', name: 'Alba', lang: 'EN', gender: 'm', style: 'reading' },
  { id: 'marius', name: 'Marius', lang: 'EN', gender: 'm', style: 'reading' },
  { id: 'javert', name: 'Javert', lang: 'EN', gender: 'm', style: 'reading' },
  { id: 'jean', name: 'Jean', lang: 'EN', gender: 'm', style: 'conversation' },
  { id: 'fantine', name: 'Fantine', lang: 'EN', gender: 'f', style: 'reading' },
  { id: 'cosette', name: 'Cosette', lang: 'EN', gender: 'f', style: 'reading' },
  { id: 'eponine', name: 'Eponine', lang: 'EN', gender: 'f', style: 'reading' },
  { id: 'azelma', name: 'Azelma', lang: 'EN', gender: 'f', style: 'reading' },
];

export const DEFAULT_VOICE_ID = 'alba';

/**
 * Get the avatar URL for a voice ID.
 * Works in content scripts (chrome.runtime.getURL) and extension pages.
 */
export function getVoiceAvatarUrl(voiceId) {
  return chrome.runtime.getURL(`assets/voices/${voiceId}.webp`);
}
