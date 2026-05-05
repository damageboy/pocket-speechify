# pocket-tts v2.1.0 Multilingual Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Pocket Speechify to use damageboy/pocket-tts v2.1.0 with metadata-driven multilingual model selection, per-language Cache API assets, and one loaded WASM model at a time.

**Architecture:** Preserve the existing content script → service worker → offscreen document → TTS worker architecture. Add language/voice catalogs and language detection in content, route `language` through the existing TTS messages, and extend offscreen/worker loading to resolve language-scoped model/tokenizer/voice assets from Cache API or Hugging Face.

**Tech Stack:** WXT, vanilla JavaScript, Vitest + happy-dom, Chrome extension APIs, offscreen Cache API, pocket-tts WASM, Hugging Face asset downloads, `tldts` for registrable-domain override keys.

---

## File Structure

### Create

- `src/languages.js`
  - Supported language catalog, default language, locale mapping, language runtime metadata, v2 Hugging Face repo/revisions, config YAML generator, cache-key/URL builders.
- `src/language-detection.js`
  - Page metadata extraction, locale normalization/mapping, domain-key derivation, override load/save helpers.
- `tests/languages.test.js`
  - Catalog/default voice/cache-key/config/URL tests.
- `tests/language-detection.test.js`
  - Metadata mapping, fallback, override precedence, domain-key tests.
- `src/tts-load-policy.js`
  - Pure helper that decides whether a playback request must load model assets, voice assets, or neither.
- `tests/tts-load-policy.test.js`
  - Unit tests for language reload vs voice-only behavior.
- `tests/remote-tts.test.js`
  - Unit tests proving `RemoteTTS` includes `language` in playback messages.

### Modify

- `package.json`, `package-lock.json`
  - Add `tldts` dependency.
- `src/voices.js`
  - Expand to v2.1.0 voice catalog, add fallback-avatar helpers, keep existing avatar URLs when files exist.
- `src/state.js`
  - Add `detectedLanguage`, `selectedLanguage`, `languageSource`; update voice cache keys to be language-scoped.
- `src/side-panels.js`
  - Add language selector to voice panel, recommended/default voice display, fallback avatar rendering, language-aware voice cache status.
- `src/pill-player.js`
  - Show language flag badge on voice button; use fallback avatar for voices without bundled image.
- `src/remote-tts.js`
  - Track language, include `language` in `tts-play-paragraph`, expose `setLanguage()`.
- `entrypoints/content.js`
  - Resolve effective page language before state/UI init; add `actions.setLanguage`; pass language to RemoteTTS play/skip paths.
- `entrypoints/offscreen/main.js`
  - Replace hardcoded v1 asset handling with language-scoped v2 asset resolver; pass real tokenizer bytes; reload worker when language changes; skip English-only normalization for non-English.
- `public/tts-worker.js`
  - Accept `language` and `tokenizerData` in `load-model`; pass non-empty tokenizer bytes to WASM; track loaded language for diagnostics.
- `scripts/build-wasm.sh`
  - Default to `damageboy/pocket-tts`; update comments/logs.
- `README.md`
  - Document multilingual support, first-use per-language downloads, default fork, and Cache API behavior.

---

## Implementation Tasks

### Task 1: Add multilingual catalogs and asset helpers

**Files:**

- Create: `src/languages.js`
- Modify: `src/voices.js`
- Test: `tests/languages.test.js`

- [ ] **Step 1: Write failing catalog tests**

Create `tests/languages.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE_ID,
  getDefaultVoiceForLanguage,
  getLanguage,
  languageFlag,
  languageFromLocale,
  buildLanguageConfigYaml,
  getModelCacheKey,
  getTokenizerCacheKey,
  getVoiceCacheKey,
  getModelUrl,
  getTokenizerUrl,
  getVoiceUrl,
} from "../src/languages.js";
import {
  VOICES,
  getVoice,
  voiceDisplayName,
  hasBundledVoiceAvatar,
} from "../src/voices.js";

const MODEL_REV = "d29db7978e464fb90cb3359ee0c69a273b9142cc";
const VOICE_REV = "e041936c75475d350b405bc870bcf7c22da4e9e6";

describe("language catalog", () => {
  it("uses English as the fallback language", () => {
    expect(DEFAULT_LANGUAGE_ID).toBe("english");
    expect(getDefaultVoiceForLanguage("unknown")).toBe("alba");
  });

  it("maps locales to supported language ids", () => {
    expect(languageFromLocale("en-US")).toBe("english");
    expect(languageFromLocale("de_DE")).toBe("german");
    expect(languageFromLocale("it")).toBe("italian");
    expect(languageFromLocale("pt-BR")).toBe("portuguese");
    expect(languageFromLocale("es-ES")).toBe("spanish");
    expect(languageFromLocale("fr-FR")).toBe("french_24l");
    expect(languageFromLocale("nl-NL")).toBe(null);
  });

  it("exposes language defaults and flags", () => {
    expect(getLanguage("german").defaultVoice).toBe("juergen");
    expect(languageFlag("spanish")).toBe("🇪🇸");
  });

  it("builds v2 cache keys by language", () => {
    expect(getModelCacheKey("german")).toBe(
      "languages/german/model.safetensors",
    );
    expect(getTokenizerCacheKey("german")).toBe(
      "languages/german/tokenizer.model",
    );
    expect(getVoiceCacheKey("german", "juergen")).toBe(
      "languages/german/embeddings/juergen.safetensors",
    );
  });

  it("builds v2 Hugging Face URLs by language and revision", () => {
    expect(getModelUrl("german")).toContain(
      `/resolve/${MODEL_REV}/languages/german/model.safetensors`,
    );
    expect(getTokenizerUrl("german")).toContain(
      `/resolve/${MODEL_REV}/languages/german/tokenizer.model`,
    );
    expect(getVoiceUrl("german", "juergen")).toContain(
      `/resolve/${VOICE_REV}/languages/german/embeddings/juergen.safetensors`,
    );
  });

  it("generates language-specific config yaml", () => {
    const germanYaml = buildLanguageConfigYaml("german");
    expect(germanYaml).toContain("remove_semicolons: true");
    expect(germanYaml).toContain("num_layers: 6");

    const frenchYaml = buildLanguageConfigYaml("french_24l");
    expect(frenchYaml).toContain("model_recommended_frames_after_eos: 8");
    expect(frenchYaml).toContain("num_layers: 24");
  });
});

describe("voice catalog", () => {
  it("contains v2 voices and metadata", () => {
    expect(VOICES.length).toBeGreaterThanOrEqual(26);
    expect(getVoice("juergen")).toMatchObject({ lang: "german", gender: "m" });
    expect(getVoice("estelle")).toMatchObject({ lang: "french", gender: "f" });
  });

  it("formats voice ids and knows bundled avatars", () => {
    expect(voiceDisplayName("bill_boerst")).toBe("Bill Boerst");
    expect(hasBundledVoiceAvatar("alba")).toBe(true);
    expect(hasBundledVoiceAvatar("juergen")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/languages.test.js
```

Expected: FAIL because `src/languages.js` does not exist and `src/voices.js` lacks the new exports.

- [ ] **Step 3: Implement `src/languages.js`**

Create `src/languages.js` with:

```js
export const DEFAULT_LANGUAGE_ID = "english";

export const POCKET_TTS_V2_REPO = "kyutai/pocket-tts-without-voice-cloning";
export const POCKET_TTS_V2_MODEL_REVISION =
  "d29db7978e464fb90cb3359ee0c69a273b9142cc";
export const POCKET_TTS_V2_VOICE_REVISION =
  "e041936c75475d350b405bc870bcf7c22da4e9e6";

export const LANGUAGES = [
  {
    id: "english",
    description: "English (latest)",
    defaultVoice: "alba",
    status: "production",
    layers: 6,
    flag: "🇬🇧",
    removeSemicolons: false,
    framesAfterEos: null,
  },
  {
    id: "german",
    description: "German",
    defaultVoice: "juergen",
    status: "production",
    layers: 6,
    flag: "🇩🇪",
    removeSemicolons: true,
    framesAfterEos: null,
  },
  {
    id: "italian",
    description: "Italian",
    defaultVoice: "giovanni",
    status: "production",
    layers: 6,
    flag: "🇮🇹",
    removeSemicolons: false,
    framesAfterEos: null,
  },
  {
    id: "portuguese",
    description: "Portuguese",
    defaultVoice: "rafael",
    status: "production",
    layers: 6,
    flag: "🇧🇷",
    removeSemicolons: false,
    framesAfterEos: null,
  },
  {
    id: "spanish",
    description: "Spanish",
    defaultVoice: "lola",
    status: "production",
    layers: 6,
    flag: "🇪🇸",
    removeSemicolons: false,
    framesAfterEos: null,
  },
  {
    id: "french_24l",
    description: "French (24-layer preview)",
    defaultVoice: "estelle",
    status: "preview",
    layers: 24,
    flag: "🇫🇷",
    removeSemicolons: true,
    framesAfterEos: 8,
  },
];

const LANGUAGE_BY_ID = Object.fromEntries(LANGUAGES.map((l) => [l.id, l]));

export function getLanguage(languageId) {
  return LANGUAGE_BY_ID[languageId] || LANGUAGE_BY_ID[DEFAULT_LANGUAGE_ID];
}

export function isSupportedLanguage(languageId) {
  return Boolean(LANGUAGE_BY_ID[languageId]);
}

export function getDefaultVoiceForLanguage(languageId) {
  return getLanguage(languageId).defaultVoice;
}

export function languageFlag(languageId) {
  return getLanguage(languageId).flag;
}

export function languageFromLocale(locale) {
  if (!locale || typeof locale !== "string") return null;
  const normalized = locale.trim().toLowerCase().replace("_", "-");
  const primary = normalized.split("-")[0];
  const map = {
    en: "english",
    de: "german",
    it: "italian",
    pt: "portuguese",
    es: "spanish",
    fr: "french_24l",
  };
  return map[primary] || null;
}

export function getModelCacheKey(languageId) {
  return `languages/${getLanguage(languageId).id}/model.safetensors`;
}

export function getTokenizerCacheKey(languageId) {
  return `languages/${getLanguage(languageId).id}/tokenizer.model`;
}

export function getVoiceCacheKey(languageId, voiceId) {
  return `languages/${getLanguage(languageId).id}/embeddings/${voiceId}.safetensors`;
}

function hfUrl(revision, path) {
  return `https://huggingface.co/${POCKET_TTS_V2_REPO}/resolve/${revision}/${path}`;
}

export function getModelUrl(languageId) {
  return hfUrl(POCKET_TTS_V2_MODEL_REVISION, getModelCacheKey(languageId));
}

export function getTokenizerUrl(languageId) {
  return hfUrl(POCKET_TTS_V2_MODEL_REVISION, getTokenizerCacheKey(languageId));
}

export function getVoiceUrl(languageId, voiceId) {
  return hfUrl(
    POCKET_TTS_V2_VOICE_REVISION,
    getVoiceCacheKey(languageId, voiceId),
  );
}

export function buildLanguageConfigYaml(languageId) {
  const lang = getLanguage(languageId);
  let header = "";
  if (lang.removeSemicolons) header += "remove_semicolons: true\n";
  if (lang.framesAfterEos !== null)
    header += `model_recommended_frames_after_eos: ${lang.framesAfterEos}\n`;

  return `${header}
flow_lm:
  insert_bos_before_voice: true
  dtype: float32
  flow:
    depth: 6
    dim: 512
  transformer:
    d_model: 1024
    hidden_scale: 4
    max_period: 10000
    num_heads: 16
    num_layers: ${lang.layers}
  lookup_table:
    dim: 1024
    n_bins: 4000
    tokenizer: sentencepiece
    tokenizer_path: dummy

mimi:
  dtype: float32
  sample_rate: 24000
  inner_dim: 32
  outer_dim: 512
  channels: 1
  frame_rate: 12.5
  seanet:
    dimension: 512
    channels: 1
    n_filters: 64
    n_residual_layers: 1
    ratios: [6, 5, 4]
    kernel_size: 7
    residual_kernel_size: 3
    last_kernel_size: 3
    dilation_base: 2
    pad_mode: constant
    compress: 2
  transformer:
    d_model: 512
    num_heads: 8
    num_layers: 2
    layer_scale: 0.01
    context: 250
    dim_feedforward: 2048
    input_dimension: 512
    output_dimensions: [512]
  quantizer:
    dimension: 32
    output_dimension: 512
`;
}
```

- [ ] **Step 4: Expand `src/voices.js`**

Replace the current 8-entry catalog with the v2 list. Preserve `DEFAULT_VOICE_ID = 'alba'` for compatibility and add helpers:

```js
export const VOICES = [
  {
    id: "alba",
    name: "Alba",
    lang: "english",
    gender: "m",
    style: "reading",
    hasAvatar: true,
  },
  {
    id: "anna",
    name: "Anna",
    lang: "english",
    gender: "f",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "azelma",
    name: "Azelma",
    lang: "english",
    gender: "f",
    style: "reading",
    hasAvatar: true,
  },
  {
    id: "bill_boerst",
    name: "Bill Boerst",
    lang: "english",
    gender: "m",
    style: "reading",
    hasAvatar: false,
  },
  {
    id: "caro_davy",
    name: "Caro Davy",
    lang: "english",
    gender: "f",
    style: "reading",
    hasAvatar: false,
  },
  {
    id: "charles",
    name: "Charles",
    lang: "english",
    gender: "m",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "cosette",
    name: "Cosette",
    lang: "english",
    gender: "f",
    style: "expressive",
    hasAvatar: true,
  },
  {
    id: "eponine",
    name: "Eponine",
    lang: "english",
    gender: "f",
    style: "reading",
    hasAvatar: true,
  },
  {
    id: "estelle",
    name: "Estelle",
    lang: "french",
    gender: "f",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "eve",
    name: "Eve",
    lang: "english",
    gender: "f",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "fantine",
    name: "Fantine",
    lang: "english",
    gender: "f",
    style: "reading",
    hasAvatar: true,
  },
  {
    id: "george",
    name: "George",
    lang: "english",
    gender: "m",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "giovanni",
    name: "Giovanni",
    lang: "italian",
    gender: "m",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "jane",
    name: "Jane",
    lang: "english",
    gender: "f",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "javert",
    name: "Javert",
    lang: "english",
    gender: "m",
    style: "conversation",
    hasAvatar: true,
  },
  {
    id: "jean",
    name: "Jean",
    lang: "english",
    gender: "m",
    style: "conversation",
    hasAvatar: true,
  },
  {
    id: "juergen",
    name: "Juergen",
    lang: "german",
    gender: "m",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "lola",
    name: "Lola",
    lang: "spanish",
    gender: "f",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "marius",
    name: "Marius",
    lang: "english",
    gender: "m",
    style: "conversation",
    hasAvatar: true,
  },
  {
    id: "mary",
    name: "Mary",
    lang: "english",
    gender: "f",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "michael",
    name: "Michael",
    lang: "english",
    gender: "m",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "paul",
    name: "Paul",
    lang: "english",
    gender: "m",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "peter_yearsley",
    name: "Peter Yearsley",
    lang: "english",
    gender: "m",
    style: "reading",
    hasAvatar: false,
  },
  {
    id: "rafael",
    name: "Rafael",
    lang: "portuguese",
    gender: "m",
    style: "conversation",
    hasAvatar: false,
  },
  {
    id: "stuart_bell",
    name: "Stuart Bell",
    lang: "english",
    gender: "m",
    style: "reading",
    hasAvatar: false,
  },
  {
    id: "vera",
    name: "Vera",
    lang: "english",
    gender: "f",
    style: "conversation",
    hasAvatar: false,
  },
];

export const DEFAULT_VOICE_ID = "alba";
const VOICE_BY_ID = Object.fromEntries(VOICES.map((v) => [v.id, v]));

export function getVoice(voiceId) {
  return VOICE_BY_ID[voiceId] || VOICE_BY_ID[DEFAULT_VOICE_ID];
}

export function voiceDisplayName(voiceId) {
  return voiceId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function hasBundledVoiceAvatar(voiceId) {
  return Boolean(getVoice(voiceId).hasAvatar);
}
```

Keep `getVoiceAvatarUrl(voiceId)` returning `browser.runtime.getURL(...)` for existing avatars.

- [ ] **Step 5: Run catalog tests**

Run:

```bash
npm test -- tests/languages.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit catalog work**

```bash
git add src/languages.js src/voices.js tests/languages.test.js
git commit -m "feat: add pocket-tts v2 language and voice catalogs"
```

---

### Task 2: Add language detection and domain overrides

**Files:**

- Create: `src/language-detection.js`
- Modify: `package.json`, `package-lock.json`
- Test: `tests/language-detection.test.js`

- [ ] **Step 1: Add `tldts` dependency**

Run:

```bash
npm install tldts
```

Expected: `package.json` and `package-lock.json` update.

- [ ] **Step 2: Write failing language-detection tests**

Create `tests/language-detection.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LANGUAGE_OVERRIDES_KEY,
  detectMetadataLanguage,
  getSiteLanguageKey,
  resolvePageLanguage,
  saveLanguageOverride,
} from "../src/language-detection.js";

beforeEach(() => {
  document.documentElement.innerHTML = "<head></head><body></body>";
  document.documentElement.removeAttribute("lang");
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
    },
  };
});

describe("getSiteLanguageKey", () => {
  it("uses registrable domains for subdomains", () => {
    expect(getSiteLanguageKey("www.news.example.co.uk")).toBe("example.co.uk");
  });

  it("keeps localhost and IP hosts exact", () => {
    expect(getSiteLanguageKey("localhost")).toBe("localhost");
    expect(getSiteLanguageKey("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("detectMetadataLanguage", () => {
  it("detects html lang before metadata tags", () => {
    document.documentElement.lang = "de-DE";
    const meta = document.createElement("meta");
    meta.setAttribute("property", "og:locale");
    meta.content = "en_US";
    document.head.appendChild(meta);
    expect(detectMetadataLanguage(document)).toEqual({
      language: "german",
      raw: "de-DE",
    });
  });

  it("detects og locale", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("property", "og:locale");
    meta.content = "fr_FR";
    document.head.appendChild(meta);
    expect(detectMetadataLanguage(document).language).toBe("french_24l");
  });

  it("returns null for unsupported metadata", () => {
    document.documentElement.lang = "nl-NL";
    expect(detectMetadataLanguage(document)).toBe(null);
  });
});

describe("resolvePageLanguage", () => {
  it("uses domain override before metadata", async () => {
    chrome.storage.local.get.mockResolvedValue({
      [LANGUAGE_OVERRIDES_KEY]: { "example.com": "spanish" },
    });
    document.documentElement.lang = "de-DE";
    await expect(
      resolvePageLanguage(new URL("https://news.example.com/story"), document),
    ).resolves.toMatchObject({
      selectedLanguage: "spanish",
      detectedLanguage: "german",
      languageSource: "override",
      siteKey: "example.com",
    });
  });

  it("uses metadata if no override exists", async () => {
    document.documentElement.lang = "it-IT";
    await expect(
      resolvePageLanguage(new URL("https://example.com"), document),
    ).resolves.toMatchObject({
      selectedLanguage: "italian",
      languageSource: "metadata",
    });
  });

  it("falls back to English silently", async () => {
    await expect(
      resolvePageLanguage(new URL("https://example.com"), document),
    ).resolves.toMatchObject({
      selectedLanguage: "english",
      detectedLanguage: null,
      languageSource: "fallback",
    });
  });
});

describe("saveLanguageOverride", () => {
  it("merges new override into storage", async () => {
    chrome.storage.local.get.mockResolvedValue({
      [LANGUAGE_OVERRIDES_KEY]: { "old.com": "german" },
    });
    await saveLanguageOverride("example.com", "spanish");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [LANGUAGE_OVERRIDES_KEY]: {
        "old.com": "german",
        "example.com": "spanish",
      },
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm test -- tests/language-detection.test.js
```

Expected: FAIL because `src/language-detection.js` does not exist.

- [ ] **Step 4: Implement `src/language-detection.js`**

Create the module:

```js
import { getDomain } from "tldts";
import {
  DEFAULT_LANGUAGE_ID,
  isSupportedLanguage,
  languageFromLocale,
} from "./languages.js";

export const LANGUAGE_OVERRIDES_KEY = "pocket-speechify-language-overrides";

export function getSiteLanguageKey(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return "";
  const domain = getDomain(host, { allowPrivateDomains: true });
  return domain || host;
}

function metaContent(doc, selector) {
  return doc.querySelector(selector)?.getAttribute("content")?.trim() || "";
}

export function detectMetadataLanguage(doc = document) {
  const candidates = [
    doc.documentElement?.getAttribute("lang") || "",
    metaContent(doc, 'meta[property="og:locale"]'),
    metaContent(doc, 'meta[http-equiv="content-language" i]'),
    metaContent(doc, 'meta[name="language" i]'),
  ];

  for (const raw of candidates) {
    const language = languageFromLocale(raw);
    if (language) return { language, raw };
  }
  return null;
}

export async function loadLanguageOverrides() {
  const result = await chrome.storage.local.get(LANGUAGE_OVERRIDES_KEY);
  return result[LANGUAGE_OVERRIDES_KEY] || {};
}

export async function saveLanguageOverride(siteKey, languageId) {
  const overrides = await loadLanguageOverrides();
  await chrome.storage.local.set({
    [LANGUAGE_OVERRIDES_KEY]: { ...overrides, [siteKey]: languageId },
  });
}

export async function resolvePageLanguage(
  url = new URL(location.href),
  doc = document,
) {
  const siteKey = getSiteLanguageKey(url.hostname);
  const detected = detectMetadataLanguage(doc);
  const overrides = await loadLanguageOverrides();
  const override = overrides[siteKey];

  if (override && isSupportedLanguage(override)) {
    return {
      siteKey,
      selectedLanguage: override,
      detectedLanguage: detected?.language || null,
      languageSource: "override",
    };
  }

  if (detected) {
    return {
      siteKey,
      selectedLanguage: detected.language,
      detectedLanguage: detected.language,
      languageSource: "metadata",
    };
  }

  return {
    siteKey,
    selectedLanguage: DEFAULT_LANGUAGE_ID,
    detectedLanguage: null,
    languageSource: "fallback",
  };
}
```

- [ ] **Step 5: Run language detection tests**

Run:

```bash
npm test -- tests/language-detection.test.js
```

Expected: PASS.

- [ ] **Step 6: Run all tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit language detection**

```bash
git add package.json package-lock.json src/language-detection.js tests/language-detection.test.js
git commit -m "feat: detect page language and domain overrides"
```

---

### Task 3: Add language state and pass language through content/RemoteTTS

**Files:**

- Modify: `src/state.js`
- Modify: `src/remote-tts.js`
- Modify: `entrypoints/content.js`
- Test: `tests/state.test.js`
- Test: `tests/remote-tts.test.js`

- [ ] **Step 1: Update state tests first**

Modify `tests/state.test.js` to assert initial language fields and language-scoped voice cache. Add tests similar to:

```js
import {
  DEFAULT_LANGUAGE_ID,
  getDefaultVoiceForLanguage,
} from "../src/languages.js";

it("initializes language state", () => {
  const state = createState({
    selectedLanguage: "german",
    detectedLanguage: "german",
    languageSource: "metadata",
  });
  expect(state.get()).toMatchObject({
    selectedLanguage: "german",
    detectedLanguage: "german",
    languageSource: "metadata",
    voiceId: getDefaultVoiceForLanguage("german"),
  });
});

it("builds language-scoped voice cache keys", () => {
  const state = createState();
  expect(state.get().voiceCache["english:alba"]).toBe("uncached");
  expect(state.get().voiceCache["german:juergen"]).toBe("uncached");
});
```

- [ ] **Step 2: Run state tests to verify they fail**

Run:

```bash
npm test -- tests/state.test.js
```

Expected: FAIL because `createState` does not accept initial language state and voice cache is not language-scoped.

- [ ] **Step 3: Update `src/state.js`**

Modify imports and state creation:

```js
import { VOICES, DEFAULT_VOICE_ID } from "./voices.js";
import {
  DEFAULT_LANGUAGE_ID,
  getDefaultVoiceForLanguage,
} from "./languages.js";

function voiceCacheKey(languageId, voiceId) {
  return `${languageId}:${voiceId}`;
}

function buildEmptyVoiceCache() {
  const entries = [];
  for (const voice of VOICES) {
    // Initialize common voice/language pairs lazily-friendly by including all languages later if desired.
    entries.push([
      voiceCacheKey(
        voice.lang === "french" ? "french_24l" : voice.lang,
        voice.id,
      ),
      "uncached",
    ]);
  }
  entries.push([
    voiceCacheKey(DEFAULT_LANGUAGE_ID, DEFAULT_VOICE_ID),
    "uncached",
  ]);
  return Object.fromEntries(entries);
}

const INITIAL_STATE = {
  // existing fields...
  selectedLanguage: DEFAULT_LANGUAGE_ID,
  detectedLanguage: null,
  languageSource: "fallback",
  voiceId: DEFAULT_VOICE_ID,
  // existing fields...
};

export function createState(initialPatch = {}) {
  const initialLanguage =
    initialPatch.selectedLanguage || INITIAL_STATE.selectedLanguage;
  const initialVoice =
    initialPatch.voiceId || getDefaultVoiceForLanguage(initialLanguage);
  let state = {
    ...INITIAL_STATE,
    ...initialPatch,
    selectedLanguage: initialLanguage,
    voiceId: initialVoice,
    voiceCache: buildEmptyVoiceCache(),
  };
  // keep existing implementation
  return {
    get,
    dispatch,
    subscribe,
    reset,
    buildEmptyVoiceCache,
    voiceCacheKey,
  };
}
```

Adjust exact code to preserve current existing state fields.

- [ ] **Step 4: Write failing `RemoteTTS` language payload test**

Create `tests/remote-tts.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteTTS } from "../src/remote-tts.js";

function paragraph(text = "Hallo Welt.") {
  return {
    text,
    words: [{ text: "Hallo" }, { text: "Welt." }],
    sentences: [{ text, words: [{ text: "Hallo" }, { text: "Welt." }] }],
  };
}

beforeEach(() => {
  globalThis.WebAssembly = globalThis.WebAssembly || {};
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      sendMessage: vi.fn(),
    },
  };
});

describe("RemoteTTS language routing", () => {
  it("includes selected language in tts-play-paragraph payload", () => {
    const tts = new RemoteTTS();
    tts.setVoice("juergen");
    tts.setLanguage("german");
    tts.play([paragraph()], 0, 0, 1.0);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tts-play-paragraph",
        language: "german",
        voiceId: "juergen",
      }),
    );
  });

  it("lets play() override the previously configured language", () => {
    const tts = new RemoteTTS();
    tts.setVoice("lola");
    tts.setLanguage("english");
    tts.play([paragraph("Hola mundo.")], 0, 0, 1.0, "spanish");

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "spanish",
        voiceId: "lola",
      }),
    );
  });
});
```

Run:

```bash
npm test -- tests/remote-tts.test.js
```

Expected: FAIL because `RemoteTTS` does not yet expose `setLanguage()` or send `language`.

- [ ] **Step 5: Update `src/remote-tts.js`**

Import the default language:

```js
import { DEFAULT_LANGUAGE_ID } from "./languages.js";
```

Add implementation:

```js
#language = DEFAULT_LANGUAGE_ID;

setLanguage(language) {
  this.#language = language || DEFAULT_LANGUAGE_ID;
}

play(paragraphs, fromParagraph = 0, fromWord = 0, speed = 1.0, language = this.#language) {
  this.#language = language || DEFAULT_LANGUAGE_ID;
  // existing logic
}
```

Add `language: this.#language` to `tts-play-paragraph` payload in `#sendCurrentParagraph()`.

- [ ] **Step 6: Update `entrypoints/content.js` initialization**

At the top imports add:

```js
import {
  resolvePageLanguage,
  saveLanguageOverride,
} from "../src/language-detection.js";
import { getDefaultVoiceForLanguage } from "../src/languages.js";
```

Inside `main()` before `createState()`:

```js
const languageResolution = await resolvePageLanguage(
  new URL(location.href),
  document,
);
console.log(
  `[Pocket Speechify] Language resolved: ${languageResolution.selectedLanguage} (${languageResolution.languageSource})`,
);
const state = createState({
  selectedLanguage: languageResolution.selectedLanguage,
  detectedLanguage: languageResolution.detectedLanguage,
  languageSource: languageResolution.languageSource,
  siteKey: languageResolution.siteKey,
});
```

Remove the old `const state = createState();`.

When creating `RemoteTTS`, call:

```js
tts.setLanguage(state.get().selectedLanguage);
```

Update every `tts.play(...)` call to pass language as fifth arg:

```js
tts.play(
  paragraphs,
  fromParagraph,
  0,
  state.get().speed,
  state.get().selectedLanguage,
);
```

and skip paths:

```js
tts.play(
  paragraphs,
  newPIdx,
  fromWord,
  state.get().speed,
  state.get().selectedLanguage,
);
```

Add to `actions`:

```js
async setLanguage(languageId) {
  console.log(`[Pocket Speechify] Language ${languageId} triggered`);
  const voiceId = getDefaultVoiceForLanguage(languageId);
  await saveLanguageOverride(state.get().siteKey, languageId);
  tts.stop();
  tts.setLanguage(languageId);
  tts.setVoice(voiceId);
  state.dispatch({
    selectedLanguage: languageId,
    languageSource: 'override',
    voiceId,
    playback: 'idle',
    currentParagraphIndex: null,
    currentSentenceIndex: null,
    currentWordIndex: null,
    elapsedSec: 0,
    panelOpen: 'voice',
  });
}
```

- [ ] **Step 7: Keep `RemoteTTS` synchronized on state changes**

In the existing state subscription:

```js
if (current.selectedLanguage !== prev.selectedLanguage) {
  tts.setLanguage(current.selectedLanguage);
}
```

- [ ] **Step 8: Run focused tests**

Run:

```bash
npm test -- tests/state.test.js tests/remote-tts.test.js tests/language-detection.test.js tests/languages.test.js
```

Expected: PASS.

- [ ] **Step 9: Run all tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 10: Commit state/message changes**

```bash
git add src/state.js src/remote-tts.js entrypoints/content.js tests/state.test.js tests/remote-tts.test.js
git commit -m "feat: route selected language through TTS playback"
```

---

### Task 4: Update voice/language UI

**Files:**

- Modify: `src/side-panels.js`
- Modify: `src/pill-player.js`
- Modify: `public/css/player.css`

- [ ] **Step 1: Add avatar helper functions to `src/voices.js` if not already complete**

Ensure `src/voices.js` exports:

```js
export function avatarInitials(voiceId) {
  return voiceDisplayName(voiceId)
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function avatarColor(voiceId) {
  let hash = 0;
  for (const ch of voiceId) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff;
  return `hsl(${Math.abs(hash) % 360}, 55%, 42%)`;
}
```

- [ ] **Step 2: Update pill voice button**

In `src/pill-player.js` imports:

```js
import {
  getVoiceAvatarUrl,
  hasBundledVoiceAvatar,
  avatarInitials,
  avatarColor,
} from "./voices.js";
import { languageFlag } from "./languages.js";
```

Replace direct voice image creation with a helper inside `initPillPlayer`:

```js
function renderVoiceButtonContent(voiceId, languageId, forceFallback = false) {
  voiceBtn.textContent = "";
  if (hasBundledVoiceAvatar(voiceId) && !forceFallback) {
    const img = document.createElement("img");
    img.style.cssText =
      "width: 26px; height: 26px; border-radius: 50%; object-fit: cover; pointer-events: none;";
    img.onerror = () => {
      console.log(
        `[Pocket Speechify] Voice avatar fallback triggered for ${voiceId}`,
      );
      renderVoiceButtonContent(voiceId, languageId, true);
    };
    img.src = getVoiceAvatarUrl(voiceId);
    voiceBtn.appendChild(img);
  } else {
    const fallback = document.createElement("span");
    fallback.className = "voice-avatar-fallback voice-avatar-fallback-small";
    fallback.style.background = avatarColor(voiceId);
    fallback.textContent = avatarInitials(voiceId);
    voiceBtn.appendChild(fallback);
  }
  const flag = document.createElement("span");
  flag.className = "language-flag-badge";
  flag.textContent = languageFlag(languageId);
  voiceBtn.appendChild(flag);
}
```

Call it initially and in state subscription when `voiceId` or `selectedLanguage` changes.

- [ ] **Step 3: Update voice panel imports**

In `src/side-panels.js` import:

```js
import {
  LANGUAGES,
  getDefaultVoiceForLanguage,
  getLanguage,
  languageFlag,
} from "./languages.js";
import {
  VOICES,
  getVoiceAvatarUrl,
  hasBundledVoiceAvatar,
  avatarInitials,
  avatarColor,
} from "./voices.js";
```

- [ ] **Step 4: Add language selector to voice panel**

In `createVoicePanel(state, actions)` change signature to include `actions`. Add after search or before search:

```js
const languageRow = document.createElement("div");
languageRow.className = "language-selector-row";

const languageLabel = document.createElement("label");
languageLabel.className = "language-selector-label";
languageLabel.textContent = "Language";

const languageSelect = document.createElement("select");
languageSelect.className = "language-selector";
for (const lang of LANGUAGES) {
  const opt = document.createElement("option");
  opt.value = lang.id;
  opt.textContent = `${lang.flag} ${lang.description}${lang.status === "preview" ? " (β)" : ""}`;
  languageSelect.appendChild(opt);
}
languageSelect.addEventListener("change", () => {
  console.log(`[Pocket Speechify] Language ${languageSelect.value} triggered`);
  actions.setLanguage(languageSelect.value);
});

languageRow.appendChild(languageLabel);
languageRow.appendChild(languageSelect);
panel.appendChild(languageRow);
```

In the voice panel `sync(s)` function, keep the dropdown aligned with current state:

```js
languageSelect.value = s.selectedLanguage;
```

Also set the initial value after creating options:

```js
languageSelect.value = state.get().selectedLanguage;
```

- [ ] **Step 5: Render recommended/default voices first**

In `renderList(selectedVoiceId, query)`, sort voices so the current language's default voice appears first, then native-language voices, then others:

```js
const selectedLanguage = state.get().selectedLanguage;
const defaultVoiceId = getDefaultVoiceForLanguage(selectedLanguage);
const filtered = // existing search
  .slice()
  .sort((a, b) => {
    if (a.id === defaultVoiceId) return -1;
    if (b.id === defaultVoiceId) return 1;
    const aNative = a.lang === getLanguage(selectedLanguage).id.replace('_24l', '');
    const bNative = b.lang === getLanguage(selectedLanguage).id.replace('_24l', '');
    if (aNative !== bNative) return aNative ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
```

Show language/default metadata in the voice item:

```js
langEl.textContent = `${languageFlag(voice.lang === "french" ? "french_24l" : voice.lang)} ${voice.lang}${voice.id === defaultVoiceId ? " · default" : ""}`;
```

Use fallback avatar when `hasBundledVoiceAvatar(voice.id)` is false.

- [ ] **Step 6: Update panel initialization**

In `initSidePanels`, change:

```js
const {
  panel: voicePanel,
  sync: syncVoice,
  resetSearch,
} = createVoicePanel(state, actions);
```

- [ ] **Step 7: Add CSS**

Append to `public/css/player.css`:

```css
.voice-avatar-fallback {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: system-ui, sans-serif;
  font-weight: 800;
  letter-spacing: -0.04em;
}
.voice-avatar-fallback-small {
  width: 26px;
  height: 26px;
  font-size: 9px;
  pointer-events: none;
}
.language-flag-badge {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #1f1f1f;
  border: 1px solid #2e2e2e;
  font-size: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.language-selector-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.language-selector-label {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
}
.language-selector {
  width: 100%;
  border: 1px solid var(--bg-divider);
  border-radius: 8px;
  background: var(--bg-primary-dark);
  color: var(--text-primary);
  padding: 8px 10px;
  font:
    13px system-ui,
    sans-serif;
}
```

Ensure `.btn` or `voiceBtn` can position the badge by setting `voiceBtn.style.position = 'relative';` or CSS class rule.

- [ ] **Step 8: Verify all new UI event handlers log**

Search manually:

```bash
rg -n "addEventListener\('(?:click|change|input)'" src/side-panels.js src/pill-player.js
```

Expected: every new or modified handler includes `console.log('[Pocket Speechify] ... clicked/triggered')`; update existing voice-selection logs from `selected` to `triggered` while editing this file.

- [ ] **Step 9: Run tests and build**

Run:

```bash
npm test
npm run build
```

Expected: PASS/build succeeds.

- [ ] **Step 10: Commit UI changes**

```bash
git add src/side-panels.js src/pill-player.js src/voices.js public/css/player.css
git commit -m "feat: show language-aware voice controls"
```

---

### Task 5: Upgrade offscreen asset caching and worker reloading

**Files:**

- Create: `src/tts-load-policy.js`
- Create: `tests/tts-load-policy.test.js`
- Modify: `entrypoints/offscreen/main.js`
- Modify: `public/tts-worker.js`

- [ ] **Step 1: Write failing load-policy tests**

Create `tests/tts-load-policy.test.js`:

```js
import { describe, expect, it } from "vitest";
import { getTTSLoadPlan } from "../src/tts-load-policy.js";

describe("getTTSLoadPlan", () => {
  it("loads model and voice when no worker exists", () => {
    expect(
      getTTSLoadPlan({
        hasWorker: false,
        currentLoadedLanguage: null,
        currentLoadedVoiceId: null,
        language: "english",
        voiceId: "alba",
      }),
    ).toEqual({ loadModel: true, loadVoice: true });
  });

  it("loads only voice when language is already loaded and voice changes", () => {
    expect(
      getTTSLoadPlan({
        hasWorker: true,
        currentLoadedLanguage: "english",
        currentLoadedVoiceId: "alba",
        language: "english",
        voiceId: "marius",
      }),
    ).toEqual({ loadModel: false, loadVoice: true });
  });

  it("loads neither model nor voice when both are already loaded", () => {
    expect(
      getTTSLoadPlan({
        hasWorker: true,
        currentLoadedLanguage: "german",
        currentLoadedVoiceId: "juergen",
        language: "german",
        voiceId: "juergen",
      }),
    ).toEqual({ loadModel: false, loadVoice: false });
  });

  it("loads model and voice when language changes", () => {
    expect(
      getTTSLoadPlan({
        hasWorker: true,
        currentLoadedLanguage: "english",
        currentLoadedVoiceId: "alba",
        language: "german",
        voiceId: "juergen",
      }),
    ).toEqual({ loadModel: true, loadVoice: true });
  });
});
```

Run:

```bash
npm test -- tests/tts-load-policy.test.js
```

Expected: FAIL because `src/tts-load-policy.js` does not exist.

- [ ] **Step 2: Implement `src/tts-load-policy.js`**

Create:

```js
export function getTTSLoadPlan({
  hasWorker,
  currentLoadedLanguage,
  currentLoadedVoiceId,
  language,
  voiceId,
}) {
  const loadModel = !hasWorker || currentLoadedLanguage !== language;
  const loadVoice = loadModel || currentLoadedVoiceId !== voiceId;
  return { loadModel, loadVoice };
}
```

Run:

```bash
npm test -- tests/tts-load-policy.test.js
```

Expected: PASS.

- [ ] **Step 3: Add language and load-policy imports to offscreen**

At top of `entrypoints/offscreen/main.js` add:

```js
import {
  DEFAULT_LANGUAGE_ID,
  buildLanguageConfigYaml,
  getDefaultVoiceForLanguage,
  getModelCacheKey,
  getTokenizerCacheKey,
  getVoiceCacheKey,
  getModelUrl,
  getTokenizerUrl,
  getVoiceUrl,
} from "../../src/languages.js";
import { getTTSLoadPlan } from "../../src/tts-load-policy.js";
```

- [ ] **Step 4: Change cache version and loaded-state variables**

Replace:

```js
const CACHE_NAME = "pocket-tts-v1";
const HF_BASE =
  "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main";
```

with:

```js
const CACHE_NAME = "pocket-tts-v2";
```

Add:

```js
let currentLoadedLanguage = null;
```

Keep `currentLoadedVoiceId`.

- [ ] **Step 5: Include language in download progress messages**

Update `downloadWithProgress(url, cacheKey, asset, voiceId)` signature to:

```js
async function downloadWithProgress(url, cacheKey, asset, voiceId, language)
```

Add `language` to `download-progress` and `download-complete` messages:

```js
sendToServiceWorker({
  type: "download-progress",
  asset,
  voiceId,
  language,
  percent,
});
sendToServiceWorker({ type: "download-complete", asset, voiceId, language });
```

- [ ] **Step 6: Add selective asset helpers**

Insert before `handlePlayParagraph`. These helpers intentionally fetch model/tokenizer/config only when the loaded language changes, and fetch voice only when the active language or voice changes:

```js
async function getOrDownloadAsset({
  cacheKey,
  url,
  asset,
  voiceId = null,
  language,
}) {
  let data = await getCached(cacheKey);
  if (data) {
    logToSW(
      `[Offscreen] ${asset}${voiceId ? ":" + voiceId : ""} for ${language} loaded from cache`,
    );
    return data;
  }
  logToSW(
    `[Offscreen] ${asset}${voiceId ? ":" + voiceId : ""} for ${language} not cached, downloading...`,
  );
  data = await downloadWithProgress(url, cacheKey, asset, voiceId, language);
  logToSW(
    `[Offscreen] ${asset}${voiceId ? ":" + voiceId : ""} for ${language} download complete`,
  );
  return data;
}

async function loadModelAssets(language) {
  const [modelData, tokenizerData] = await Promise.all([
    getOrDownloadAsset({
      cacheKey: getModelCacheKey(language),
      url: getModelUrl(language),
      asset: "model",
      language,
    }),
    getOrDownloadAsset({
      cacheKey: getTokenizerCacheKey(language),
      url: getTokenizerUrl(language),
      asset: "tokenizer",
      language,
    }),
  ]);

  const configData = new TextEncoder().encode(
    buildLanguageConfigYaml(language),
  ).buffer;
  return { modelData, tokenizerData, configData };
}

async function loadVoiceAsset(language, voiceId) {
  return getOrDownloadAsset({
    cacheKey: getVoiceCacheKey(language, voiceId),
    url: getVoiceUrl(language, voiceId),
    asset: "voice",
    voiceId,
    language,
  });
}
```

- [ ] **Step 7: Update `handlePlayParagraph` destructuring**

Change destructuring to include `language`:

```js
const { ..., voiceId, speed, tabId, language = DEFAULT_LANGUAGE_ID } = msg;
const effectiveVoiceId = voiceId || getDefaultVoiceForLanguage(language);
```

Use `effectiveVoiceId` for voice loading.

- [ ] **Step 8: Replace hardcoded model/voice download block with selective asset loading**

Remove the old hardcoded `modelKey`, `voiceKey`, `HF_BASE` model/voice download code.

Replace with:

```js
const loadPlan = getTTSLoadPlan({
  hasWorker: Boolean(worker),
  currentLoadedLanguage,
  currentLoadedVoiceId,
  language,
  voiceId: effectiveVoiceId,
});

const modelAssets = loadPlan.loadModel ? await loadModelAssets(language) : null;
const voiceData = loadPlan.loadVoice
  ? await loadVoiceAsset(language, effectiveVoiceId)
  : null;
await ensureWorker(modelAssets, voiceData, effectiveVoiceId, language);
```

Expected behavior: changing voices within an already-loaded language reads/downloads only the new voice embedding; it does not read the 100MB+ model or tokenizer from Cache API.

- [ ] **Step 9: Update `ensureWorker` signature and reload logic**

Replace `async function ensureWorker(modelData, voiceData, voiceId)` with:

```js
async function ensureWorker(modelAssets, voiceData, voiceId, language) {
  const mustLoadModel = !worker || currentLoadedLanguage !== language;

  if (mustLoadModel) {
    if (!modelAssets)
      throw new Error(`Missing model assets for language ${language}`);
    const { modelData, tokenizerData, configData } = modelAssets;

    if (worker) {
      worker.terminate();
      worker = null;
    }
    currentLoadedVoiceId = null;
    currentLoadedLanguage = null;

    worker = new Worker(browser.runtime.getURL("tts-worker.js"));
    worker.onmessage = (e) => handleWorkerMessage(e.data);
    worker.onerror = (e) => {
      logToSW(
        `[Offscreen] WORKER ERROR: ${e.message} at ${e.filename}:${e.lineno}`,
      );
    };

    const wasmJsUrl = browser.runtime.getURL("wasm/pocket_tts.js");
    worker.postMessage(
      {
        type: "load-model",
        modelData,
        tokenizerData,
        configData,
        wasmJsUrl,
        language,
      },
      [modelData, tokenizerData, configData],
    );
    await waitForWorkerMessage("model-ready");
    currentLoadedLanguage = language;
  }

  if (currentLoadedVoiceId !== voiceId) {
    if (!voiceData)
      throw new Error(`Missing voice data for ${language}:${voiceId}`);
    worker.postMessage({ type: "load-voice", voiceId, voiceData, language });
    await waitForWorkerMessage("voice-ready");
    currentLoadedVoiceId = voiceId;
  }
}
```

- [ ] **Step 10: Update cache clear path**

In `tts-clear-cache`, after terminating worker also set:

```js
currentLoadedLanguage = null;
```

- [ ] **Step 11: Update `public/tts-worker.js` load-model case**

Change the tokenizer handling to use provided data:

```js
const tokenizerBytes = new Uint8Array(msg.tokenizerData);
if (tokenizerBytes.byteLength === 0) {
  throw new Error(
    "Tokenizer data is required for pocket-tts v2 language models",
  );
}

diag(
  `[TTS Worker] Loading language=${msg.language}: config=${configBytes.byteLength}B, weights=${(weightsBytes.byteLength / 1024 / 1024).toFixed(1)}MB, tokenizer=${tokenizerBytes.byteLength}B`,
);
model.load_from_buffer(configBytes, weightsBytes, tokenizerBytes);
```

Post model-ready with language:

```js
self.postMessage({ type: "model-ready", sampleRate, language: msg.language });
```

- [ ] **Step 12: Run tests and build**

Run:

```bash
npm test
npm run build
```

Expected: PASS/build succeeds.

- [ ] **Step 13: Commit offscreen/worker changes**

```bash
git add src/tts-load-policy.js tests/tts-load-policy.test.js entrypoints/offscreen/main.js public/tts-worker.js
git commit -m "feat: load pocket-tts v2 assets by language"
```

---

### Task 6: Gate English-only normalization for multilingual playback

**Files:**

- Modify: `entrypoints/offscreen/main.js`

- [ ] **Step 1: Locate paragraph normalization block**

Find the block in `handlePlayParagraph` that does:

```js
const abbrevMap = await loadAbbreviations();
const expandedParaText = expandAbbreviations(paragraphText, abbrevMap);
await ensureTextProcessing();
const normalizedParaText = tnNormalizeSentence(expandedParaText);
```

- [ ] **Step 2: Replace with language-gated normalization**

Use:

```js
let normalizedParaText = paragraphText;
if (language === "english") {
  const abbrevMap = await loadAbbreviations();
  const expandedParaText = expandAbbreviations(paragraphText, abbrevMap);
  await ensureTextProcessing();
  normalizedParaText = tnNormalizeSentence(expandedParaText);
  if (normalizedParaText !== expandedParaText) {
    logToSW(
      `[Offscreen] Para TN: "${expandedParaText.substring(0, 60)}" → "${normalizedParaText.substring(0, 60)}"`,
    );
  }
} else {
  logToSW(
    `[Offscreen] Skipping English text normalization for language=${language}`,
  );
}
```

Remove the old duplicate TN log to avoid referencing `expandedParaText` outside the English branch.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit normalization gating**

```bash
git add entrypoints/offscreen/main.js
git commit -m "fix: avoid English normalization for non-English TTS"
```

---

### Task 7: Update download progress state for language-scoped assets

**Files:**

- Modify: `entrypoints/background.js`
- Modify: `entrypoints/content.js`
- Modify: `src/state.js`
- Modify: `src/side-panels.js`

- [ ] **Step 1: Update service-worker progress logging key**

In `entrypoints/background.js` change:

```js
const key = `${msg.asset}:${msg.voiceId || ""}`;
```

to:

```js
const key = `${msg.language || ""}:${msg.asset}:${msg.voiceId || ""}`;
```

Update log format to include language when present.

- [ ] **Step 2: Update content download-progress handling**

In `entrypoints/content.js`, stop relying on the old single `modelCached` boolean for UI decisions; keep it only as a backward-compatible coarse indicator or replace it later with language-scoped model cache state. For this task, download progress is the source of truth.

Change voice cache updates to use language-scoped keys:

```js
const { asset, voiceId, language, percent } = e.detail;
const cacheLanguage = language || state.get().selectedLanguage;
state.dispatch({
  downloadProgress: { asset, voiceId, language: cacheLanguage, percent },
});
if (asset === "voice" && voiceId) {
  const key = state.voiceCacheKey(cacheLanguage, voiceId);
  const voiceCache = { ...state.get().voiceCache, [key]: "downloading" };
  state.dispatch({ voiceCache });
}
```

On complete, define `cacheLanguage` in this handler too and clear progress for every completed asset:

```js
const { asset, voiceId, language } = e.detail;
const cacheLanguage = language || state.get().selectedLanguage;

if (asset === "voice" && voiceId) {
  const key = state.voiceCacheKey(cacheLanguage, voiceId);
  const voiceCache = { ...state.get().voiceCache, [key]: "cached" };
  state.dispatch({ voiceCache, downloadProgress: null });
} else {
  state.dispatch({ downloadProgress: null });
}
```

- [ ] **Step 3: Update voice panel cache-status lookup**

In `src/side-panels.js`, replace:

```js
const cacheStatus = state.get().voiceCache[voice.id] || "uncached";
```

with:

```js
const cacheKey = state.voiceCacheKey(state.get().selectedLanguage, voice.id);
const cacheStatus = state.get().voiceCache[cacheKey] || "uncached";
```

- [ ] **Step 4: Run tests/build**

Run:

```bash
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit progress-state changes**

```bash
git add entrypoints/background.js entrypoints/content.js src/state.js src/side-panels.js
git commit -m "feat: track language-scoped download progress"
```

---

### Task 8: Update build script and README

**Files:**

- Modify: `scripts/build-wasm.sh`
- Modify: `README.md`

- [ ] **Step 1: Update failing grep check manually**

Run:

```bash
rg -n "babybirdprd|damageboy|pocket-tts 2|multilingual|language" scripts/build-wasm.sh README.md
```

Expected before edits: existing babybird references remain.

- [ ] **Step 2: Edit `scripts/build-wasm.sh` default repo**

Change comments and clone command:

```bash
# 1. Clones damageboy/pocket-tts to a temp directory
```

and:

```bash
echo "--- Cloning damageboy/pocket-tts ---"
git clone --depth 1 https://github.com/damageboy/pocket-tts "$SRC_DIR"
```

Keep all `POCKET_TTS_REPO` override behavior unchanged.

- [ ] **Step 3: Update README feature list**

Change the voice/model bullets to describe:

- Multilingual pocket-tts v2.1.0 support.
- Automatic metadata language detection.
- Domain language overrides.
- Per-language first-use model downloads around 100MB/language.
- Per-language model/tokenizer/voice assets are cached via Cache API.
- Only one model is loaded into memory at a time.

- [ ] **Step 4: Update README build-script section**

Replace babybird default wording with damageboy fork default wording and keep local override docs:

```md
By default `build-wasm.sh` clones `damageboy/pocket-tts`, the v2.1.0 multilingual fork used by this extension. Set `POCKET_TTS_REPO` to point at a local checkout instead...
```

- [ ] **Step 5: Verify docs/build references**

Run:

```bash
rg -n "babybirdprd|tts_b6369a24|8 voices|236MB" README.md scripts/build-wasm.sh
```

Expected: no stale user-facing claims remain, except historical context if intentionally kept.

- [ ] **Step 6: Commit docs/build changes**

```bash
git add scripts/build-wasm.sh README.md
git commit -m "docs: describe multilingual pocket-tts v2 support"
```

---

### Task 9: Full verification and manual smoke checklist

**Files:**

- No code changes expected unless failures are found.

- [ ] **Step 1: Run unit tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run production build**

```bash
npm run build
```

Expected: PASS. If the build hook rebuilds WASM, confirm it uses `damageboy/pocket-tts` or local `POCKET_TTS_REPO` if set.

- [ ] **Step 3: Verify no stale hardcoded v1 asset paths remain**

Run:

```bash
rg -n "tts_b6369a24|tokenizer=embedded|babybirdprd|pocket-tts-v1|HF_BASE|embeddings/\$\{voiceId\}" entrypoints public src scripts README.md
```

Expected: no active hardcoded v1 model path or babybird default. Any `embeddings/${voiceId}` occurrence must include a language-scoped path.

- [ ] **Step 4: Manual smoke test: English first use**

1. Load `.output/chrome-mv3` as an unpacked extension.
2. Open an English page with `<html lang="en">`.
3. Click play.
4. Expected:
   - Pill shows 🇬🇧 and Alba.
   - Offscreen logs download/cache English model, tokenizer, and Alba voice.
   - Playback, highlighting, pause/resume, speed, skip still work.

- [ ] **Step 5: Manual smoke test: German first use**

1. Open a German test page with `<html lang="de">`.
2. Click play.
3. Expected:
   - Pill shows 🇩🇪 and Juergen.
   - Offscreen logs German model/tokenizer/voice download or cache hit.
   - Worker logs `language=german` and non-empty tokenizer bytes.
   - Playback produces German output.

- [ ] **Step 6: Manual smoke test: cache/model switching**

1. After English and German are cached, switch between English and German pages.
2. Expected:
   - Downloads are not repeated.
   - Worker reloads when language changes.
   - Only one active model is loaded in the worker at a time.

- [ ] **Step 7: Manual smoke test: domain override**

1. On a page, open voice panel.
2. Change language manually.
3. Reload another page on the same registrable domain.
4. Expected:
   - Override language wins over metadata.
   - Voice resets to override language's default voice.

- [ ] **Step 8: Commit any verification fixes**

If smoke tests required fixes:

```bash
git add <changed-files>
git commit -m "fix: stabilize multilingual TTS smoke flow"
```

If no fixes were needed, do not create an empty commit.

---

## Handoff Notes

- Use generated config YAML in `src/languages.js` for the first implementation. Do not vendor all language YAML files unless generated config proves incompatible.
- Do not implement in-memory multi-model pools.
- Do not add text-content language detection yet; metadata only.
- Do not add cache-management UI yet.
- Every new UI event handler must log a `[Pocket Speechify] ... clicked/triggered` message per `AGENTS.md`.
