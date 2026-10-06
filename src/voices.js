import catalog from '../public/wasm/models.json' with { type: 'json' };
import { DEFAULT_LANGUAGE_ID, getDefaultVoiceForLanguage } from './languages.js';

// Only these avatars are bundled with the extension. Voice metadata and asset
// availability are supplied by the upstream catalog, including future voices.
const BUNDLED_AVATARS = new Set(['alba', 'marius', 'javert', 'jean', 'fantine', 'cosette', 'eponine', 'azelma']);

export const VOICES = catalog.voices.map(voice => ({
  id: voice.id,
  name: voiceDisplayName(voice.id),
  lang: voice.language,
  gender: voice.gender,
  style: voice.style,
  hasAvatar: BUNDLED_AVATARS.has(voice.id),
}));

export const DEFAULT_VOICE_ID = getDefaultVoiceForLanguage(DEFAULT_LANGUAGE_ID);

const VOICE_BY_ID = Object.fromEntries(VOICES.map(voice => [voice.id, voice]));

export function getVoice(voiceId) {
  return VOICE_BY_ID[voiceId] || VOICE_BY_ID[DEFAULT_VOICE_ID];
}

export function voiceDisplayName(voiceId) {
  return voiceId.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export function hasBundledVoiceAvatar(voiceId) {
  return BUNDLED_AVATARS.has(voiceId);
}

export function avatarInitials(voiceId) {
  return voiceDisplayName(voiceId).split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
}

export function avatarColor(voiceId) {
  let hash = 0;
  for (const ch of voiceId) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff;
  return `hsl(${Math.abs(hash) % 360}, 55%, 42%)`;
}

export function getVoiceAvatarUrl(voiceId) {
  return browser.runtime.getURL(`assets/voices/${voiceId}.webp`);
}
