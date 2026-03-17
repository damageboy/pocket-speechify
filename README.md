# Pocket Speechify

[![Build Extension](https://github.com/damageboy/pocket-speechify/actions/workflows/release.yml/badge.svg?branch=master)](https://github.com/damageboy/pocket-speechify/actions/workflows/release.yml)
[![Latest Release](https://img.shields.io/github/v/release/damageboy/pocket-speechify?label=release)](https://github.com/damageboy/pocket-speechify/releases/latest)
[![Download .crx](https://img.shields.io/github/downloads/damageboy/pocket-speechify/total?label=downloads)](https://github.com/damageboy/pocket-speechify/releases/latest)

A lightweight Chrome extension that replicates the Speechify text-to-speech UI — floating pill player, word highlighting, and voice selection — powered by [Kyutai's pocket-tts](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning) WASM model running entirely in your browser.

---

## Features

- **Floating pill player** — fixed to the right edge of any page, draggable, collapses when not in use
- **Word-level highlighting** — sentence and word highlights track playback in real time
- **Pitch-preserving speed control** — 0.4x to 4.5x via [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) WASM; pitch stays natural at any speed
- **8 voices** — Alba, Marius, Javert, Jean, Fantine, Cosette, Eponine, Azelma
- **Hover-to-play** — hover over any paragraph to start reading from there
- **Scroll-to-highlight** — floating nav pill snaps you back to the word being read
- **Fully offline after first load** — model and voices are cached locally (~236MB model + ~1MB per voice)
- **No API keys, no accounts, no telemetry**

---

## Installation

### From a release (recommended)

1. Download the latest `.zip` from [Releases](https://github.com/damageboy/pocket-speechify/releases/latest)
2. Unzip it
3. Open `chrome://extensions`, enable **Developer mode**
4. Click **Load unpacked** and select the unzipped folder

> **Note:** The `.crx` file in releases is self-signed and Chrome will refuse to install it directly. Use the `.zip` + Load unpacked method above.

### From source

```bash
git clone https://github.com/damageboy/pocket-speechify.git
cd pocket-speechify
```

WASM artifacts are vendored in `wasm/`. If you need to rebuild them:

```bash
# Requires Rust + wasm-pack
bash scripts/build-wasm.sh
```

Then load the directory as an unpacked extension.

---

## Usage

1. Navigate to any article or page with readable text
2. The pill player appears on the right edge — click **▶** to start reading
3. The extension reads the page paragraph by paragraph, highlighting the current sentence and word
4. On first use, the TTS model downloads automatically (~236MB, cached permanently)
5. Voices download on first selection (~1MB each, also cached)

### Controls

| Control | Action |
|---------|--------|
| **▶ / ⏸** | Play / Pause |
| **⏭ / ⏮** | Skip forward / backward one sentence |
| **Speed button** | Open speed panel (0.4x–4.5x, pitch-preserved) |
| **Voice button** | Open voice selector |
| **Hover over paragraph** | Shows play button to start from that paragraph |
| **Scroll-nav pill** | Appears when you scroll away from the highlighted text — click to jump back |

---

## Architecture

```
Content Script          Service Worker         Offscreen Document        TTS Worker
──────────────          ──────────────         ──────────────────        ──────────
UI (pill, panels)  ──►  Message router    ──►  Model + voice cache       WASM inference
Word highlighting  ◄──  (chrome.runtime)  ◄──  AudioContext + scheduler  Streaming chunks
                                               Signalsmith Stretch
```

- **Content script** — injects the pill player UI into pages via shadow DOM, handles highlighting
- **Service worker** — routes messages between content script and offscreen document
- **Offscreen document** — owns all audio: downloads model/voices, runs the scheduler, applies pitch-preserving time-stretching via Signalsmith Stretch WASM
- **TTS worker** — runs pocket-tts WASM inference in a Web Worker; streams audio chunks back

### Speed control

Speed changes are pitch-preserving. The offscreen document uses [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) in direct WASM mode — matching the pattern used in the Rust reference implementation. Each audio chunk is time-stretched to `outputLen = inputLen / speed` samples via the STFT engine, then scheduled for playback at 1.0x. Pitch is preserved by the algorithm itself, not by pitch-shifting compensation.

---

## Development

### Pre-commit hooks

The repo uses pre-commit hooks that verify the extension build on every commit:

```bash
pip install pre-commit
pre-commit install
```

### Build scripts

| Script | Purpose |
|--------|---------|
| `scripts/build-wasm.sh` | Build pocket-tts WASM from source |
| `scripts/verify-build.sh` | Check all required files are present |
| `scripts/stamp-version.sh` | Stamp `manifest.json` version from git tag |
| `scripts/package.sh` | Create `.zip` for Chrome Web Store |

### CI

Every push to `master` runs the build workflow and uploads a build artifact. Tagged pushes (`v*`) additionally create a GitHub Release with `.zip` and `.crx` attachments.

---

## Credits

- [Kyutai](https://kyutai.org/) — [pocket-tts](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning) WASM TTS model
- [Signalsmith Audio](https://signalsmith-audio.co.uk/) — [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) pitch-preserving time stretching
- [Speechify](https://speechify.com/) — UI/UX reference
