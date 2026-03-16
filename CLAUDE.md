# Pocket Speechify

A Chrome extension that replicates the Speechify text-to-speech UI as a lightweight, self-contained tool.

## Development Rules

- **Every user interaction (button click, UI event) MUST have a `console.log` message** for debugging. This applies to all event handlers in pill-player.js, side-panels.js, hover-player.js, and any other UI code. Format: `console.log('[Pocket Speechify] <action> clicked/triggered')`.

## Extension Architecture & Context Boundaries

There are 4 execution contexts. Each has different API access. **Never assume an API from one context works in another.**

### Content Script (content.js, src/*.js loaded via import)
- **Runs in:** the web page's JS context (injected by Chrome)
- **Has access to:** DOM, `chrome.runtime.sendMessage()`, `chrome.runtime.onMessage`
- **Does NOT have:** Cache API (operates on page origin, not extension origin), `chrome.offscreen`, `chrome.tabs`, AudioContext for TTS
- **Console visible in:** page DevTools (F12)
- **Files:** `content.js`, `src/remote-tts.js`, `src/pill-player.js`, `src/side-panels.js`, `src/highlight.js`, `src/hover-player.js`, `src/scroll-nav.js`, `src/state.js`, `src/voices.js`, `src/content-extractor.js`, `src/icons.js`, `src/dom-utils.js`, `src/logger.js`, `src/mock-tts.js`

### Service Worker (service-worker.js)
- **Runs in:** extension background context
- **Has access to:** `chrome.runtime`, `chrome.tabs`, `chrome.offscreen`, `chrome.runtime.getContexts()`
- **Does NOT have:** DOM, `window`, AudioContext, Cache API (technically available but should NOT be used here — offscreen doc owns caching)
- **Console visible in:** chrome://extensions → "service worker" link
- **Role:** message router only. Routes messages between content scripts and offscreen document using `source` field tagging.

### Offscreen Document (offscreen.html, offscreen.js)
- **Runs in:** extension origin, hidden page
- **Has access to:** Cache API (extension origin), AudioContext, Web Workers, `chrome.runtime.sendMessage()`, `chrome.runtime.onMessage`, `chrome.runtime.getURL()`, full DOM APIs, ES module imports
- **Does NOT have:** `chrome.tabs`, visible UI
- **Console visible in:** its own DevTools (may appear under chrome://extensions inspect views, or may need manual inspection)
- **Role:** owns audio playback, weight/voice caching, download lifecycle, word timing estimation, spawns and manages the TTS worker

### TTS Web Worker (src/tts-worker.js)
- **Runs in:** worker thread spawned by offscreen document
- **Has access to:** `self.postMessage()`, `self.onmessage`, `importScripts()`, dynamic `import()` (can import `chrome-extension://` URLs passed to it), `console.log` (visible in offscreen doc's DevTools)
- **Does NOT have:** `chrome.*` APIs (no `chrome.runtime`, no `chrome.runtime.getURL()`), DOM, Cache API, AudioContext
- **Console visible in:** offscreen document's DevTools (worker sub-panel)
- **Role:** WASM inference only. Receives model weights, config, voice data, and text via `postMessage`. Sends back audio chunks.

### Message Routing Pattern
```
Content Script ──(chrome.runtime.sendMessage)──► Service Worker
    source: 'content'                               │
                                                     │ (chrome.runtime.sendMessage)
                                                     ▼
                                              Offscreen Document
                                              source: 'service-worker'
                                                     │
                                                     │ (worker.postMessage)
                                                     ▼
                                                TTS Web Worker

TTS Web Worker ──(self.postMessage)──► Offscreen Document
                                              │
                                              │ (chrome.runtime.sendMessage)
                                              ▼
                                        Service Worker
                                        source: 'offscreen'
                                              │
                                              │ (chrome.tabs.sendMessage, strips source)
                                              ▼
                                        Content Script
```

- Content script messages identified by `sender.tab` in service worker
- Offscreen messages identified by `msg.source === 'offscreen'`
- Service worker adds `source: 'service-worker'` when forwarding to offscreen
- Service worker strips `source` when relaying to content scripts
- TTS Worker receives all data via `postMessage` (URLs, ArrayBuffers) — it cannot fetch extension resources itself

## Goal

Build a Chrome extension with a floating pill player that reads web page text aloud, matching Speechify's UI/UX patterns.

## Reference: Speechify Extension UI Reverse-Engineering

All reference screenshots are in `./screenshots/`.

### Architecture

- Speechify injects multiple `<div>` elements into the page body, each with its own **shadow DOM** for style isolation
- Key injected elements:
  - `speechify-pill-player` — the main floating player widget
  - `speechify-hover-player-shadow-root` — hover player (appears on text selection)
  - `speechify-global-notifications` — toast notifications
  - `speechify-settings-modal` — settings modal overlay
  - `speechify-scroll-to-highlight` — auto-scroll during playback
  - `speechify-theme` — a `<style>` element injecting CSS variables into `:root`
- Uses Emotion CSS (CSS-in-JS) inside shadow DOM with `player-emotion-cache-*` class names

### Pill Player (Main Widget)

The core UI is a **vertical floating bar** on the right edge of the viewport.

**Layout & Position:**
- `position: fixed`
- `z-index: 2147483645` (near max int)
- `top: calc(50% - 171px)`, `right: 18px`
- Width: **48px**, Height: ~**230px**
- `cursor: move` (draggable)

**Visual Style:**
- Background: `#1f1f1f` (dark)
- Shape: `border-radius: 100px` (pill/capsule)
- Box shadow: subtle purple glow — `rgba(106, 120, 252, 0.5)` layered at multiple blur radii
- Font: `system-ui, sans-serif`
- All text/icons: `#ffffff`
- Entry animation: slide in from right (`translateX(60px)` to `translateX(0)`, 0.08s ease-out)

**Components (top to bottom, vertically stacked with `gap: 4px`):**

1. **Summarize Button** — 48x48px
   - Audio waveform SVG icon (5 vertical bars of varying height)
   - `background: unset`, `border-radius: 50%`
   - Opens a summarize side panel on click
   - SVG paths: vertical lines with `stroke="currentColor"`, `stroke-width="2"`, `stroke-linecap="round"`

2. **Duration Display** — 48x20px
   - Format: `MM:SS` (e.g., "41:14")
   - Font: `system-ui`, `12px`, `font-weight: 700`, `font-variant-numeric: tabular-nums`
   - Two `<div>` elements (minutes + seconds) with a ":" separator between them
   - `text-align: center`

3. **Play Button** — 32x32px circle
   - Background: `#4759f7` (Speechify blue-purple)
   - Hover: `#4454e3`, Active: `#3d4ac4`
   - `border-radius: 50%`
   - Contains a play triangle SVG (`viewBox="0 0 24 24"`, `fill="currentColor"`)
   - SVG path: `M7.164 19.84c.474 0 .835-.088 1.283-.36l9.826-5.705c.844-.483 1.336-.958 1.336-1.775 0-.809-.492-1.292-1.336-1.775L8.447 4.52c-.448-.263-.809-.36-1.283-.36-.95 0-1.714.677-1.714 1.907v11.866c0 1.23.765 1.907 1.714 1.907z`

4. **Divider** — 28x2px
   - `background-color: #2e2e2e`
   - `border-radius: 2px`
   - Separates play controls from secondary controls

5. **Voice Selector** — 32x32px circle button
   - Shows a circular avatar image of the selected voice
   - Image: `border-radius: 50%`, `object-fit: cover`, 80% of button size
   - `background: unset`
   - Hover: `background-color: #363636`, Active: `#3d3d3d`

6. **Speed Control** — 32x32px circle button
   - Displays current speed as text (e.g., "1x")
   - Font: `system-ui`, `14px`, `font-weight: 700`, `color: #ffffff`
   - Same hover/active states as voice selector

### Pill Player — Hover Expanded State

When the user hovers over the pill, it **expands vertically** from ~230px to ~452px height, revealing 6 additional buttons below the speed control. The main pill container grows with `transition: height 150ms ease-in-out`.

**Additional buttons (top to bottom, all 32x32px circles):**

7. **Save to Library** — `aria-label: "Save to library button, shortcut Alt + S"`
   - Bookmark/plus icon (viewBox 0 0 21 20): bookmark shape with a + symbol
   - `background: transparent`, `color: #ffffff`
   - Hover: `background-color: #363636`, Active: `#3d3d3d`
   - SVG class: `icon--save`

8. **Report a Problem** — `aria-label: "Report a Problem with Speechify App"`
   - Speech bubble icon (viewBox 0 0 20 20)
   - Same hover/active states
   - `color: #ffffff` (icon via `fill="currentColor"`)

9. **View Library** — `aria-label: "View Library"`
   - Speechify logo/hand icon (viewBox 0 0 34 20, wider SVG)
   - Icon size: `24x24px` (larger than others)
   - Same hover/active states

10. **Settings** — `aria-label: "Speechify Side Player Settings"`
    - Gear/cog icon (viewBox 0 0 20 20)
    - Icon size: `20x20px`
    - Same hover/active states

11. **Upgrade to Premium** — `aria-label: "Upgrade to Premium button"`
    - Horizontal bar icon with gradient fills (linear + radial gradients)
    - Icon size: `20x20px`
    - Same hover/active states

12. **Turn Off Speechify** — `aria-label: "Turn Off Speechify button"` — **20x20px** (smaller)
    - X/close icon (viewBox 0 0 20 20)
    - `background: #2e2e2e`, `border-radius: 50%`
    - Icon fill: `#9f9f9f` (muted gray)
    - Hover: icon fill changes to `#ffffff`
    - Visually separated from the group above, acts as dismiss

**Expansion behavior:**
- The bottom section (`pill-player-bottom-section`) animates opacity: starts at 0 during the height transition, then fades to 1
- Class `.animating` is added during transition (opacity 0), removed when complete (opacity 1)
- `transition: opacity 0.05s ease-in-out forwards`

### Side Panels (expand left from pill)

When clicking voice or speed buttons, a panel slides out to the left of the pill.

**Shared Panel Design:**
- Background: `#1f1f1f`
- `border-radius: 12px`
- `position: absolute`, `right: 60px`, `top: -12px`
- Box shadow: same purple glow as pill, plus `0px 4px 6px 0px rgba(0, 0, 0, 0.32)`
- Close button (X) in top-right corner — `20x20px`, `color: #ffffff`, hover opacity 0.75
- Font: `system-ui, sans-serif`

**Voice Panel (~400x510px):**
- Search bar at top with magnifying glass icon
- "Language" dropdown filter with chevron
- "Recents" section — list of recently used voices
- "Featured" section — grid of voice cards
- Each voice card has:
  - Avatar with organic blob clip-path (SVG `<clipPath>`)
  - Voice name (bold, white)
  - Language tag (e.g., "EN", secondary color `#9f9f9f`)
- Recents show small 32px avatars; Featured show larger 64px avatars

**Speed Panel (~360x422px):**
- Header: "Normal" label + "Duration: ~MM:SS" estimate
- Speed display with +/- buttons: minus `[ - ]` current speed `[ + ]` plus
- Preset speed buttons: `0.8x`, `1x`, `1.2x`
- Slider: `aria-valuemin="0.4"`, `aria-valuemax="4.5"`, custom track with tick marks
- "Increase Speed Automatically" toggle — "Speed up as you go every 600 words"
- Slider thumb: 16px circle, `#1E1E1E` with lock icon

### Design Tokens (CSS Custom Properties)

```css
/* Backgrounds */
--bg-primary:       #1f1f1f;  /* Main surfaces */
--bg-primary-dark:  #121212;  /* Deeper surfaces */
--bg-hover:         #363636;  /* Hover states */
--bg-active:        #3d3d3d;  /* Active/pressed states */
--bg-divider:       #2e2e2e;  /* Dividers, borders */
--bg-cta:           #4759f7;  /* CTA / play button */
--bg-cta-hover:     #4454e3;  /* CTA hover */
--bg-cta-active:    #3d4ac4;  /* CTA pressed */

/* Text & Icons */
--text-primary:     #ffffff;  /* Primary text, icons */
--text-secondary:   #9f9f9f;  /* Secondary / muted text */
--text-tertiary:    #7a7a7a;  /* Tertiary text */

/* Accent & Highlights */
--accent-blue:      #5c6ae5;  /* Secondary CTA */
--electric-blue:    #8894fe;  /* Active states, highlights */
--highlight-primary:#5666f0;  /* Text being read */
--highlight-hover:  #e68600;  /* Hover highlight */

/* Semantic */
--color-success:    #23ae75;
--color-alert:      #e68600;
--color-critical:   #eb3830;

/* Overlay */
--dimmer:           rgba(0, 0, 0, 0.4);
```

### Pill Player — Playing State

During playback, the pill player changes:

1. **Play → Pause Button** — same 32x32px circle, now shows:
   - **Circular progress ring** around the button (SVG `viewBox="0 0 100 100"`)
     - Trail: `stroke-dasharray: 289.027px`, full circle path
     - Progress: same path with `stroke-dashoffset` animated to show remaining time
     - Gradient: `#EA6AFF` → `#6B78FC` (pink to purple-blue)
     - Hover gradient: `#E055F5` → `#5F6DEF`
     - Active gradient: `#D640EB` → `#5362E2`
     - `stroke-width: 8`
   - **Pause icon** (viewBox 0 0 10 12): two vertical bars
     - Path 1: `M0 1C0 0.447715 0.447715 0 1 0H3C3.55228 0 4 0.447715 4 1V11C4 11.5523 3.55228 12 3 12H1C0.447715 12 0 11.5523 0 11V1Z`
     - Path 2: `M6 1C6 0.447715 6.44772 0 7 0H9C9.55228 0 10 0.447715 10 1V11C10 11.5523 9.55228 12 9 12H7...`
   - Duration counter updates to show remaining time

2. **Skip Sentence Buttons** — appear below pause button, 16x16px each, side by side
   - **Skip backward** (double left chevron, viewBox 0 0 16 16):
     ```
     M7.48552 5.81939C7.77841 5.5265 7.77841 5.05163 7.48552 4.75873C7.19263 4.46584 6.71776 4.46584 6.42486 4.75873L3.64545 7.53812C3.5048 7.67877 3.42578 7.86953 3.42578 8.06845C3.42578 8.26736 3.5048 8.45813 3.64545 8.59878L6.42486 11.3782C6.71775 11.6711 7.19263 11.6711 7.48552 11.3782C7.77841 11.0853 7.77841 10.6104 7.48552 10.3175L5.23644 8.06845L7.48552 5.81939ZM12.0343 5.81939...
     ```
   - **Skip forward** (double right chevron, viewBox 0 0 16 16):
     ```
     M3.96576 4.75873C4.25866 4.46584 4.73353 4.46584 5.02642 4.75873L7.80583 7.53814C7.94648 7.67879 8.0255 7.86956 8.0255 8.06847C8.0255 8.26739 7.94648 8.45815 7.80583 8.5988L5.02642 11.3782...
     ```
   - `fill="#ffffff"`

### Text Highlighting (CSS Paint API)

Speechify uses the **CSS Houdini Paint Worklet** for highlighting text during playback. This is a high-performance approach that avoids DOM manipulation.

**How it works:**
- Sets `background-image: paint(speechifyPlaybackHighlighter)` on the paragraph being read
- Passes highlight coordinates via CSS custom properties
- The paint worklet draws colored rectangles behind the text

**CSS Custom Properties on the active paragraph:**

| Property | Purpose | Example |
|----------|---------|---------|
| `--speechifyPlaybackHighlighterElemColor` | Base element color for dark/light detection | `rgb(34, 40, 49)` |
| `--speechifyPlaybackHighlighterHighlightSentenceInfo` | Comma-separated rect coords (x,y,w,h tuples) for sentence highlight | `528.9,123,451.8,26.4,...` |
| `--speechifyPlaybackHighlighterHighlightWordInfo` | Single rect (x,y,w,h) for current word | `343.98,243,97.47,26.4` |
| `--speechifyPlaybackHighlighterHighlightWordClipInfo` | Clip rect for word animation | Same format as WordInfo |
| `--speechifyPlaybackHighlighterSentenceHighlightColorDark` | Sentence highlight (dark mode) | `#444766` |
| `--speechifyPlaybackHighlighterSentenceHighlightColorLight` | Sentence highlight (light mode) | `#e0e3ff` |
| `--speechifyPlaybackHighlighterWordHighlightColorDark` | Word highlight (dark mode) | `#5666f0` |
| `--speechifyPlaybackHighlighterWordHighlightColorLight` | Word highlight (light mode) | `#abb3fe` |
| `--speechifyPlaybackHighlighterElemMatrix` | Transform matrix | `1,1,0,0,0,0` |

**Visual result:**
- **Sentence highlight**: dark blue-gray background (`#444766`) spanning the entire sentence being read
- **Word highlight**: brighter blue (`#5666f0`) on the individual word currently being spoken
- Word highlight animates/moves from word to word as speech progresses

**Implementation note for our extension:** Since the CSS Paint API requires registering a paint worklet and has limited browser support, we can use a simpler approach: overlay `<div>` elements with absolute positioning matching text rects (via `Range.getBoundingClientRect()`), or use the CSS Custom Highlight API (`CSS.highlights`).

### Hover Player (Paragraph Play Button)

Appears when hovering over a paragraph during idle state (not during playback).

- Container: `speechify-hover-player-shadow-root` → `speechify-hover-player-container`
- **Button size**: 28x28px outer, 20x20px icon
- `position: absolute`, positioned at the left edge of the hovered paragraph
- `z-index: 2147483640`
- **Icon**: circular play button — blue circle with white play triangle
  - SVG (viewBox 0 0 24 24): blue circle `fill="#4759F7"` + play triangle `fill="white"`
  - Play path: `M16.5 11.134C17.1667 11.5189 17.1667 12.4811 16.5 12.866L10.5 16.3301C9.83333 16.715 9 16.2339 9 15.4641L9 8.53592C9 7.76611 9.83333 7.28499 10.5 7.66989L16.5 11.134Z`
- **Progress bar** on top of button during playback: 3px height
  - `linear-gradient(90deg, #4759f7 52.5%, rgba(107, 120, 252, 0) 93.6%)`
  - Animates width from 0% to 100%
  - `border-radius: 4px 0 0 4px`
- **Animations**: `fadeIn` (100ms ease-out), `fadeOut` (200ms ease-out)
- Hover/active: opacity 0.75 / 0.5

### Scroll-to-Highlight Widget (Paragraph Navigation)

A small floating pill that appears at the **top or bottom center** of the viewport when the user scrolls away from the currently-read text. Clicking it scrolls back to the highlighted paragraph.

**Layout:**
- `position: fixed`, `z-index: 2147483646`
- Centered horizontally: `left: 50%`, `transform: translateX(-50%)`
- **Top version**: `top: 16px`, `margin-top: -30px` (slides in from above)
- **Bottom version**: `transform: translate(-50%, -100%)`, `margin-top: 30px` (slides in from below)

**Visual:**
- Background: `var(--speechify-bg-prim-w-80)` → `#2e2e2e`
- `border-radius: 10px`
- `padding: 4px`
- `min-width: 60px`
- `box-shadow: 0 4px 12px -4px rgba(0, 0, 0, 0.16)`
- `transition: all 0.25s ease-out`
- Starts at `opacity: 0`, animates to `opacity: 1`

**Components (horizontal layout with `gap: 2px`):**
1. **Up/Down arrow** — 17x17px chevron SVG, `color: var(--speechify-icn-txt-prim)` (#ffffff)
   - Top widget: arrow rotated 180deg (points up)
   - Bottom widget: arrow points down
2. **Current word button** — displays the word currently being spoken
   - Font: `system-ui`, `14px`, `font-weight: 500`, `line-height: 1.43`, `letter-spacing: -0.07px`
   - Background: `var(--speechify-hglt-prim)` → `#5666f0`
   - `padding: 4px 6px`, `border-radius: 6px`
   - `white-space: nowrap`
   - `color: var(--speechify-icn-txt-prim)` (#ffffff)

**Interaction:** hover dims arrow + word button to opacity 0.75, active to 0.5

### Notifications

- Container: `speechify-global-notifications-root`
- `position: fixed`, `top: 0`, `left: 0`, `width: 100vw`
- Background: `#1f1f1f`, `border-radius: 20px`, `box-shadow: 0px 8px 24px 0px #00000029`
- Entry animation: slide down from top (`translateY(-20px)` to `translateY(0)`)
- Transition: `0.33s cubic-bezier(0.17, 0.89, 0.32, 1.27)` (slight overshoot)

### Key SVG Icons

**Play icon** (viewBox 0 0 24 24):
```
M7.164 19.84c.474 0 .835-.088 1.283-.36l9.826-5.705c.844-.483 1.336-.958 1.336-1.775 0-.809-.492-1.292-1.336-1.775L8.447 4.52c-.448-.263-.809-.36-1.283-.36-.95 0-1.714.677-1.714 1.907v11.866c0 1.23.765 1.907 1.714 1.907z
```

**Waveform/Summarize icon** (viewBox 0 0 20 20, 5 vertical bars):
```
M10 6.66663L10 15 (center, tallest)
M3.33301 8.33337L3.33301 10.8334 (left, shortest)
M16.667 8.33337L16.667 10.8334 (right, shortest)
M6.66699 4.16663L6.66699 12.5 (left-center)
M13.333 5L13.333 12.5 (right-center)
```

**Close (X) icon** (viewBox 0 0 20 20):
```
M4.87361 3.45952C4.48309 3.06899 3.84992 3.06899 3.4594 3.45952...
```

**Search icon** (viewBox 0 0 20 20):
```
M14 9C14 11.7614 11.7614 14 9 14C6.23858 14 4 11.7614 4 9...
```

**Pause icon** (viewBox 0 0 10 12, two vertical bars):
```
Bar 1: M0 1C0 0.447715 0.447715 0 1 0H3C3.55228 0 4 0.447715 4 1V11C4 11.5523 3.55228 12 3 12H1C0.447715 12 0 11.5523 0 11V1Z
Bar 2: M6 1C6 0.447715 6.44772 0 7 0H9C9.55228 0 10 0.447715 10 1V11C10 11.5523 9.55228 12 9 12H7C6.44772 12 6 11.5523 6 11V1Z
```

**Hover player play icon** (viewBox 0 0 24 24, circle + triangle):
```
Circle: cx="12" cy="12" r="12" fill="#4759F7"
Triangle: M16.5 11.134C17.1667 11.5189 17.1667 12.4811 16.5 12.866L10.5 16.3301C9.83333 16.715 9 16.2339 9 15.4641L9 8.53592C9 7.76611 9.83333 7.28499 10.5 7.66989L16.5 11.134Z (fill white)
```

**Skip backward** (viewBox 0 0 16 16, double left chevron):
```
M7.48552 5.81939...L3.64545 7.53812...L6.42486 11.3782...L5.23644 8.06845L7.48552 5.81939Z
M12.0343 5.81939...L8.19428 7.53812...L10.9737 11.3782...L9.78527 8.06845L12.0343 5.81939Z
```

**Skip forward** (viewBox 0 0 16 16, double right chevron):
```
M3.96576 4.75873...L7.80583 7.53814...L5.02642 11.3782...L6.21484 8.06847L3.96576 5.81939Z
M8.5145 4.75873...L12.3546 7.53814...L9.57516 11.3782...L10.7636 8.06847L8.5145 5.81939Z
```

**Chevron (scroll-to-highlight arrow)** (viewBox 0 0 17 17):
```
M12.7803 6.96967C13.0732 7.26256 13.0732 7.73744 12.7803 8.03033L8.78033 12.0303C8.63968 12.171 8.44891 12.25 8.25 12.25C8.05109 12.25 7.86032 12.171 7.71967 12.0303L3.71967 8.03033C3.42678 7.73744 3.42678 7.26256 3.71967 6.96967C4.01256 6.67678 4.48744 6.67678 4.78033 6.96967L8.25 10.4393L11.7197 6.96967C12.0126 6.67678 12.4874 6.67678 12.7803 6.96967Z
```

## Implementation Plan

### Phase 1: Chrome Extension Scaffold
- `manifest.json` (Manifest V3)
- Content script that injects the pill player into pages
- Shadow DOM for style isolation

### Phase 2: Pill Player UI
- Vertical floating bar with all 6 components
- Drag to reposition
- Slide-in animation on load
- Dark theme matching Speechify's design tokens

### Phase 3: Side Panels
- Voice selection panel (can use browser's built-in `speechSynthesis.getVoices()`)
- Speed control panel with slider and presets

### Phase 4: TTS Engine
- Use Web Speech API (`SpeechSynthesisUtterance`) for text-to-speech
- Extract readable text from page (similar to reader mode)
- Track current sentence and word boundaries via `SpeechSynthesisUtterance` `boundary` event

### Phase 5: Text Highlighting
- Highlight current sentence with background overlay (`#444766` dark, `#e0e3ff` light)
- Highlight current word with brighter color (`#5666f0` dark, `#abb3fe` light)
- Use `Range.getBoundingClientRect()` to get text positions
- Overlay absolutely-positioned `<div>` elements (simpler than CSS Paint API)
- Auto-scroll to keep highlighted text in view

### Phase 6: Playback State UI
- Swap play → pause icon with circular progress ring
- Show skip sentence backward/forward buttons (16x16 double chevrons)
- Update duration counter with remaining time
- Show hover player progress bar (3px gradient) during paragraph playback

### Phase 7: Hover Player (Paragraph Play)
- Detect paragraph hover via `mouseenter`/`mouseleave` on `<p>` elements
- Show 28x28px floating play button at left edge of hovered paragraph
- Click to start reading from that paragraph
- fadeIn/fadeOut animations (100ms/200ms)

### Phase 8: Scroll-to-Highlight Navigation
- When user scrolls away from highlighted text, show navigation pill
- Top pill (arrow up) when highlight is above viewport
- Bottom pill (arrow down) when highlight is below
- Show current word being read in `#5666f0` badge
- Click to scroll back to highlighted text
- Fade in/out with `0.25s ease-out` transition
