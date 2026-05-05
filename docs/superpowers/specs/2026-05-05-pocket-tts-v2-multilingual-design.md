# pocket-tts v2.1.0 Multilingual Upgrade Design

**Date:** 2026-05-05
**Status:** Approved
**Goal:** Extend the existing Pocket Speechify architecture to support damageboy/pocket-tts v2.1.0 multilingual WASM models, with automatic page-language selection and per-language Cache API assets while loading only one model into WASM memory at a time.

## Decisions

| Aspect | Decision |
|--------|----------|
| Upgrade style | Extend the current extension architecture; do not replace the runtime with the pocket-tts demo app runtime |
| Default pocket-tts source | `https://github.com/damageboy/pocket-tts` in `scripts/build-wasm.sh`; keep `POCKET_TTS_REPO` local override |
| Supported initial languages | Production: English, German, Italian, Portuguese, Spanish. Preview: French via `french_24l`. French metadata may auto-select `french_24l` because there is no production French model; other preview 24-layer variants should not be auto-selected while production models exist |
| Language priority | Domain override > page metadata detection > English fallback |
| Override scope | Registrable-domain style site key, not exact origin |
| Binary asset storage | Same Cache API strategy used today in the offscreen document; not `localStorage` |
| In-memory model policy | Cache many language assets locally, but load only one pocket-tts model in the WASM worker at a time |
| Tokenizer handling | v2 must pass real per-language tokenizer bytes to `load_from_buffer`; no empty tokenizer fallback |
| Voice catalog | Use v2.1.0 voice/language metadata from the damageboy/pocket-tts fork |
| UI | Show current language/flag and default/recommended voices without disrupting the existing pill/player UX |

## Current State

The extension currently assumes the v1 English-only pocket-tts model:

- `entrypoints/offscreen/main.js` hardcodes the Hugging Face base repo, the English v1-ish model filename, `public/config.yaml`, and a single global model cache key.
- `public/tts-worker.js` passes an empty tokenizer byte array to `load_from_buffer`, relying on an embedded English tokenizer fallback.
- `src/voices.js` contains only 8 English voices and assumes every voice has a bundled avatar image.
- `src/state.js`, `src/remote-tts.js`, and the UI do not track selected or detected language.

The upgrade should preserve the existing offscreen audio scheduler, pitch-preserving stretch pipeline, highlighting, hover player, and message-routing boundaries.

## Target Architecture

Runtime boundaries remain unchanged:

```text
Content Script ──► Service Worker ──► Offscreen Document ──► TTS Worker ──► pocket-tts WASM
```

Responsibilities after the upgrade:

- **Content script** detects page language, applies domain overrides, owns UI state, and sends `language` with playback requests.
- **Service worker** remains a message router and continues tagging `source` fields. It should not own language, cache, or audio logic.
- **Offscreen document** owns Cache API downloads, per-language asset resolution, active model/voice tracking, worker reinitialization, audio scheduling, and speed stretching.
- **TTS worker** owns a single active `WasmTTSModel`, the active voice state, and streaming inference.

## Language Catalog

Create a catalog module that is the extension source of truth for supported languages and voices. It should mirror the v2.1.0 data observed in `/Users/dmg/projects/pocket-tts`:

### Languages

| Language id | Description | Default voice | Status | Layers | Flag |
|-------------|-------------|---------------|--------|--------|------|
| `english` | English (latest) | `alba` | production | 6 | 🇬🇧 |
| `german` | German | `juergen` | production | 6 | 🇩🇪 |
| `italian` | Italian | `giovanni` | production | 6 | 🇮🇹 |
| `portuguese` | Portuguese | `rafael` | production | 6 | 🇧🇷 |
| `spanish` | Spanish | `lola` | production | 6 | 🇪🇸 |
| `french_24l` | French (24-layer preview) | `estelle` | preview | 24 | 🇫🇷 |

Catalog may also include preview `german_24l`, `italian_24l`, `portuguese_24l`, and `spanish_24l` for future manual selection, but automatic metadata detection should prefer production 6-layer models when available.

### Voices

Include all v2.1.0 predefined voices:

`alba`, `anna`, `azelma`, `bill_boerst`, `caro_davy`, `charles`, `cosette`, `eponine`, `estelle`, `eve`, `fantine`, `george`, `giovanni`, `jane`, `javert`, `jean`, `juergen`, `lola`, `marius`, `mary`, `michael`, `paul`, `peter_yearsley`, `rafael`, `stuart_bell`, `vera`.

Each voice entry should include id/name, gender, style, native language, and whether it has a bundled avatar. Existing English avatars should continue to work. New voices without avatar files should render generated fallback avatars instead of broken images.

## Language Selection Flow

On content-script initialization:

1. Derive a domain-level site key from `location.hostname`. Use a real registrable-domain parser (`tldts` or equivalent) so subdomains of `example.com` share one key while public suffixes such as `co.uk` are handled correctly. Keep `localhost`, IP addresses, and extension/internal URLs as exact-host keys.
2. Read language overrides from `chrome.storage.local`.
3. If an override exists for that domain and maps to a supported language, use it.
4. Otherwise inspect page metadata in this order:
   - `document.documentElement.lang`
   - `meta[property="og:locale"]`
   - `meta[http-equiv="content-language"]`
   - `meta[name="language"]`
5. Map detected locale/language to a supported language id:
   - `en`, `en-*`, `en_*` → `english`
   - `de`, `de-*`, `de_*` → `german`
   - `it`, `it-*`, `it_*` → `italian`
   - `pt`, `pt-*`, `pt_*` → `portuguese`
   - `es`, `es-*`, `es_*` → `spanish`
   - `fr`, `fr-*`, `fr_*` → `french_24l`
6. If detection is unsupported or empty, silently use `english`.

State should distinguish:

- `detectedLanguage`: metadata-derived result or `null`.
- `selectedLanguage`: effective language after override/detection/fallback.
- `languageSource`: `override`, `metadata`, or `fallback`.

When the user manually changes language in the UI, save the language as the domain-level override, update `selectedLanguage`, and reset `voiceId` to the new language's default voice. Initial page auto-selection also uses the selected language's default voice unless the user later chooses a different voice in the same session. Domain overrides store language only, not voice.

## Asset Resolution and Cache Keys

Keep the current offscreen Cache API download pattern, including resumable downloads and progress events, but use v2 language-scoped cache keys.

Use a cache version such as `pocket-tts-v2` to avoid mixing old v1 assets with v2 assets.

Recommended logical keys:

```text
model:     languages/{language}/model.safetensors
config:    languages/{language}/config.yaml or generated equivalent
voice:     languages/{language}/embeddings/{voiceId}.safetensors
tokenizer: languages/{language}/tokenizer.model
```

Actual request URLs should point at the v2 without-voice-cloning Hugging Face repo and revisions used by the fork's WASM demo:

```text
repo: kyutai/pocket-tts-without-voice-cloning
model/tokenizer revision: d29db7978e464fb90cb3359ee0c69a273b9142cc
voice revision: e041936c75475d350b405bc870bcf7c22da4e9e6

model:     /languages/{language}/model.safetensors
tokenizer: /languages/{language}/tokenizer.model
voice:     /languages/{language}/embeddings/{voiceId}.safetensors

example model URL:
https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/d29db7978e464fb90cb3359ee0c69a273b9142cc/languages/german/model.safetensors
```

The implementation may either vendor per-language YAML config files into `public/config/languages/{language}.yaml` or generate config YAML in JavaScript using language metadata, borrowing the proven approach from the fork's `wasm-tts.worker.ts`. If generated, it must include language-specific fields such as 24-layer transformer depth, `remove_semicolons`, and `model_recommended_frames_after_eos` where applicable.

## Worker and Model Switching

Offscreen should track:

```js
currentLoadedLanguage
currentLoadedVoiceId
```

Playback request messages should include:

```js
{
  type: 'tts-play-paragraph',
  language,
  voiceId,
  // existing fields unchanged
}
```

When `language !== currentLoadedLanguage`:

1. Cancel or invalidate active generation with the existing internal generation-token mechanism.
2. Terminate the old worker or create a fresh `WasmTTSModel` inside the existing worker.
3. Resolve/download/cache model, tokenizer, and config for the requested language.
4. Send model bytes, tokenizer bytes, config bytes, and language to the worker.
5. Await `model-ready`.
6. Reset `currentLoadedVoiceId` because voice embeddings are language-scoped.
7. Load the requested/default voice for that language.

When only `voiceId` changes within the same language, reuse the loaded model and only load the new voice embedding.

The TTS worker must call:

```js
model.load_from_buffer(configBytes, weightsBytes, tokenizerBytes)
```

with non-empty tokenizer bytes for v2 languages.

## UI Design

Keep the current Speechify-style pill and side-panel interaction model.

### Pill

- The voice button continues to show the selected voice avatar.
- Add a small flag badge for `selectedLanguage` on/near the voice button.
- If avatar image loading fails or the voice lacks a bundled avatar, render a generated fallback avatar.

### Voice panel

- Show the current language at the top, including flag and description.
- Add a language selector/dropdown in the existing side panel.
- Show the language default voice first, visually marked as default/recommended.
- Show voices grouped or annotated by native language. Native-language voices should be prominent, but cross-lingual voices remain selectable because pocket-tts supports cross-lingual embeddings.
- Selecting language logs a user interaction message and saves a domain override.
- Selecting voice logs a user interaction message and updates `voiceId`.

All new UI event handlers must follow the project rule: every user interaction logs a `console.log('[Pocket Speechify] ... clicked/triggered')` message.

## Text Normalization

The current offscreen normalization path includes English-oriented abbreviation expansion and `text-processing-rs` normalization. The multilingual upgrade must avoid making non-English text worse.

Initial policy:

- Keep current abbreviation expansion and `tnNormalizeSentence` path for English.
- For non-English languages, bypass the English abbreviation map and `tnNormalizeSentence`; use the paragraph text as extracted, plus existing generic sentence splitting and any model-level behavior encoded in the v2 config such as `remove_semicolons`.
- Maintain existing sentence/word timing behavior as much as possible.

Further language-specific text normalization can be a later enhancement.

## Build and Source Changes

Update `scripts/build-wasm.sh`:

- Default clone URL changes from `https://github.com/babybirdprd/pocket-tts` to `https://github.com/damageboy/pocket-tts`.
- Update comments/docs to say the damageboy fork is the default v2.1.0 source.
- Keep `POCKET_TTS_REPO` override exactly as today for local iteration.

README should be updated to describe multilingual support, per-language first-use downloads, Cache API behavior, and the new default fork.

## Testing Strategy

Add or update unit tests for:

- Language metadata extraction and mapping.
- English fallback for unsupported/unknown languages.
- Domain override precedence over metadata.
- Domain key derivation.
- Language catalog default voice selection.
- Voice catalog fallback avatar behavior.
- Asset URL and cache-key generation for model/tokenizer/voice.
- State initialization with detected/selected language fields.
- RemoteTTS message payload includes `language`.
- Offscreen worker reload decision: reload on language change, voice-only load on voice change.

Manual verification should cover:

1. English page downloads English model/tokenizer/voice on first use, then reuses cache.
2. German page auto-selects German and downloads German assets on first use.
3. Returning to English reuses the cached English model but reloads it into WASM memory.
4. Manual language change stores a domain override and persists across reloads.
5. Unsupported language metadata silently falls back to English.
6. Existing highlighting, pause/resume, speed control, skip, hover player, and scroll-nav still work.

## Open Follow-ups

These are intentionally out of scope for the first implementation plan:

- True multi-model in-memory worker pool.
- Automatic content-language detection from text content rather than metadata.
- Per-language text normalization beyond safe initial behavior.
- Cache management UI for deleting individual language models.
- User-facing unsupported-language warning.
