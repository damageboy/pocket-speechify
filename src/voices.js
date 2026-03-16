// src/voices.js

/**
 * Pocket-tts voice definitions.
 * Voice IDs match the safetensors filenames on HuggingFace.
 */
export const VOICES = [
  { id: 'alba', name: 'Alba', lang: 'EN' },
  { id: 'marius', name: 'Marius', lang: 'EN' },
  { id: 'javert', name: 'Javert', lang: 'EN' },
  { id: 'jean', name: 'Jean', lang: 'EN' },
  { id: 'fantine', name: 'Fantine', lang: 'EN' },
  { id: 'cosette', name: 'Cosette', lang: 'EN' },
  { id: 'eponine', name: 'Eponine', lang: 'EN' },
  { id: 'azelma', name: 'Azelma', lang: 'EN' },
];

export const DEFAULT_VOICE_ID = 'alba';
