# Content-Aware Pill Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the pill player by default only on likely article pages, while keeping manual extension-icon toggle and best-effort playback for pages with enough prose.

**Architecture:** Add a focused article detector module that scores extracted blocks and DOM candidates using deterministic readability heuristics. Thread detector results through content initialization into the pill UI, using explicit `initiallyVisible` and `hasPlayableContent` options and a play-action guard.

**Tech Stack:** JavaScript ES modules, WXT content script, Chrome extension APIs, Vitest with Happy DOM.

---

## File Structure

- Create `src/article-detector.js`
  - Owns page readability scoring.
  - Exports `detectReadableArticle(doc, paragraphs, options = {})`.
  - Does not mutate the DOM or extension state.
- Create `tests/article-detector.test.js`
  - Synthetic DOM fixtures for detector thresholds and scoring.
  - Stubs visibility through an injected predicate so Happy DOM layout limitations do not make tests flaky.
- Create or update `tests/pill-player.test.js`
  - Verifies `initPillPlayer()` respects `initiallyVisible` and `hasPlayableContent`.
  - Verifies clicking disabled play does not call `actions.play()`.
- Modify `src/pill-player.js`
  - Add an optional options parameter to `initPillPlayer()`.
  - Use `hasPlayableContent` instead of raw `paragraphs.length` for play enablement.
  - Apply initial hidden state with the existing `style.display = 'none'` mechanism.
- Modify `entrypoints/content.js`
  - Import and run `detectReadableArticle()` after `extractContent()`.
  - Guard `actions.play()` using `hasPlayableContent`.
  - Pass visibility/playability options into `initPillPlayer()`.
  - Initialize highlights for playable pages and hover/scroll widgets only for auto-show article pages.

---

### Task 1: Detector Tests

**Files:**

- Create: `tests/article-detector.test.js`
- Reads: `docs/superpowers/specs/2026-05-05-content-aware-pill-visibility-design.md`
- Reads: `tests/content-extractor.test.js`

- [ ] **Step 1: Write failing detector tests**

Create `tests/article-detector.test.js` with helpers that build DOM, mark elements visible, run `extractContent()`, then call `detectReadableArticle()`.

Use an injected visibility predicate instead of relying on Happy DOM layout:

```js
import { describe, it, expect, beforeEach } from "vitest";
import { extractContent } from "../src/content-extractor.js";
import { detectReadableArticle } from "../src/article-detector.js";

function words(count, prefix = "word") {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
}

function paragraph(wordCount, prefix) {
  return `${words(wordCount, prefix)}.`;
}

function setBodyHtml(html) {
  document.body.innerHTML = html;
  document.body.querySelectorAll("*").forEach((el) => {
    Object.defineProperty(el, "offsetParent", {
      get: () => document.body,
      configurable: true,
    });
  });
}

function detect() {
  const paragraphs = extractContent();
  return detectReadableArticle(document, paragraphs, {
    isVisible: () => true,
  });
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("detectReadableArticle", () => {
  it("auto-shows an article page with metadata and long paragraphs", () => {
    document.head.innerHTML = '<meta property="og:type" content="article">';
    setBodyHtml(`
      <article>
        <p>${paragraph(120, "alpha")}</p>
        <p>${paragraph(120, "bravo")}</p>
        <p>${paragraph(120, "charlie")}</p>
      </article>
    `);

    const result = detect();

    expect(result.isReadableArticle).toBe(true);
    expect(result.canPlayBestEffort).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.65);
    expect(result.proseParagraphIndexes).toHaveLength(3);
  });

  it("keeps a link-heavy homepage hidden by default", () => {
    const cards = Array.from(
      { length: 20 },
      (_, i) => `
      <li><a href="/story-${i}">Story ${i} ${words(12, `link${i}`)}</a></li>
    `,
    ).join("");
    setBodyHtml(`<main><ul>${cards}</ul></main>`);

    const result = detect();

    expect(result.isReadableArticle).toBe(false);
    expect(result.canPlayBestEffort).toBe(false);
  });

  it("disables best-effort playback for a short page", () => {
    setBodyHtml("<main><p>Short text only.</p></main>");

    const result = detect();

    expect(result.isReadableArticle).toBe(false);
    expect(result.canPlayBestEffort).toBe(false);
  });

  it("auto-shows strong body-only prose without metadata", () => {
    setBodyHtml(`
      <p>${paragraph(220, "alpha")}</p>
      <p>${paragraph(220, "bravo")}</p>
      <p>${paragraph(220, "charlie")}</p>
    `);

    const result = detect();

    expect(result.isReadableArticle).toBe(true);
    expect(result.canPlayBestEffort).toBe(true);
  });

  it("allows manual best-effort for enough prose with weak article confidence", () => {
    setBodyHtml(`
      <main>
        <p>${paragraph(70, "alpha")}</p>
        <p>${paragraph(70, "bravo")}</p>
      </main>
    `);

    const result = detect();

    expect(result.isReadableArticle).toBe(false);
    expect(result.canPlayBestEffort).toBe(true);
  });

  it("recognizes JSON-LD Article metadata", () => {
    document.head.innerHTML = `
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"NewsArticle"}
      </script>
    `;
    setBodyHtml(`
      <main>
        <p>${paragraph(120, "alpha")}</p>
        <p>${paragraph(120, "bravo")}</p>
        <p>${paragraph(120, "charlie")}</p>
      </main>
    `);

    const result = detect();

    expect(result.isReadableArticle).toBe(true);
  });
});
```

- [ ] **Step 2: Run detector tests and verify they fail**

Run:

```bash
npm test -- tests/article-detector.test.js
```

Expected: FAIL because `../src/article-detector.js` does not exist yet.

- [ ] **Step 3: Commit failing tests is not required**

Do not commit failing tests alone unless your workflow requires checkpoint commits. Continue to Task 2.

---

### Task 2: Detector Implementation

**Files:**

- Create: `src/article-detector.js`
- Test: `tests/article-detector.test.js`

- [ ] **Step 1: Implement `src/article-detector.js` minimally**

Create `src/article-detector.js` implementing the spec thresholds. Keep helper functions small and pure.

Implementation skeleton:

```js
const PROSE_TAGS = new Set(["P", "BLOCKQUOTE"]);
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const SKIP_TAGS = new Set([
  "NAV",
  "FOOTER",
  "HEADER",
  "ASIDE",
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
]);
const ARTICLE_TYPES = new Set(["Article", "NewsArticle", "BlogPosting"]);

const DEFAULT_OPTIONS = {
  isVisible: (el) => el?.getClientRects?.().length > 0,
};

export function detectReadableArticle(doc, paragraphs, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const candidates = buildCandidates(doc, opts);
  const hasArticleMetadata = detectArticleMetadata(doc);
  const scored = candidates.map((candidate) =>
    scoreCandidate(candidate, paragraphs, hasArticleMetadata, opts),
  );
  const selected =
    scored.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.proseWordCount - a.proseWordCount;
    })[0] || emptyScore(doc.body, hasArticleMetadata);

  const isReadableArticle =
    selected.confidence >= 0.65 &&
    selected.proseWordCount >= 300 &&
    selected.longProseBlockCount >= 3 &&
    selected.linkDensity < 0.5;

  const canPlayBestEffort =
    selected.proseWordCount >= 120 && selected.proseBlockCount >= 2;

  return {
    isReadableArticle,
    canPlayBestEffort,
    confidence: selected.confidence,
    reason: selected.reason,
    proseParagraphIndexes: selected.proseParagraphIndexes,
  };
}
```

Add helpers:

```js
function buildCandidates(doc, opts) {
  const roots = [
    ...doc.querySelectorAll("article"),
    ...doc.querySelectorAll("main"),
    doc.body,
  ].filter(Boolean);

  return Array.from(new Set(roots)).filter((root) =>
    isUsableElement(root, opts),
  );
}

function isUsableElement(el, opts) {
  if (!el || isInSkippedRegion(el)) return false;
  if (el.tagName === "BODY") return true;
  return opts.isVisible(el);
}

function scoreCandidate(root, paragraphs, hasArticleMetadata, opts) {
  const proseParagraphIndexes = [];
  let proseWordCount = 0;
  let proseBlockCount = 0;
  let longProseBlockCount = 0;

  paragraphs.forEach((paragraph, index) => {
    if (!root.contains(paragraph.element)) return;
    if (!isProseLikeBlock(paragraph)) return;
    if (!opts.isVisible(paragraph.element)) return;
    if (isInSkippedRegion(paragraph.element)) return;

    const wordCount = paragraph.words?.length || countWords(paragraph.text);
    proseParagraphIndexes.push(index);
    proseWordCount += wordCount;
    proseBlockCount += 1;
    if (paragraph.text.length >= 80 && wordCount >= 15)
      longProseBlockCount += 1;
  });

  const linkDensity = calculateLinkDensity(root, opts);
  const confidence = calculateConfidence({
    root,
    hasArticleMetadata,
    proseWordCount,
    longProseBlockCount,
    linkDensity,
  });

  return {
    root,
    proseParagraphIndexes,
    proseWordCount,
    proseBlockCount,
    longProseBlockCount,
    linkDensity,
    confidence,
    reason: `confidence=${confidence.toFixed(2)} proseWords=${proseWordCount} longBlocks=${longProseBlockCount} linkDensity=${linkDensity.toFixed(2)} root=${root.tagName}`,
  };
}
```

Use these deterministic rules:

```js
function isProseLikeBlock(paragraph) {
  const tag = paragraph.element?.tagName;
  const wordCount = paragraph.words?.length || countWords(paragraph.text);
  if (!paragraph.text || paragraph.text.length < 40 || wordCount < 8)
    return false;
  if (PROSE_TAGS.has(tag)) return true;
  if (HEADING_TAGS.has(tag)) return /[.!?]/.test(paragraph.text);
  return false;
}

function calculateConfidence({
  root,
  hasArticleMetadata,
  proseWordCount,
  longProseBlockCount,
  linkDensity,
}) {
  let confidence = 0;
  if (hasArticleMetadata) confidence += 0.25;
  if (root.tagName === "ARTICLE") confidence += 0.2;
  if (root.tagName === "MAIN") confidence += 0.1;
  if (proseWordCount >= 300) confidence += 0.2;
  if (proseWordCount >= 600) confidence += 0.2;
  if (longProseBlockCount >= 3) confidence += 0.2;
  if (linkDensity < 0.35) confidence += 0.1;
  if (linkDensity >= 0.5) confidence -= 0.25;
  return Math.max(0, Math.min(1, confidence));
}
```

Implement metadata detection for:

- `meta[property="og:type"]` or `meta[name="og:type"]` content equal to `article` case-insensitively.
- JSON-LD objects/arrays with `@type` string or array containing `Article`, `NewsArticle`, or `BlogPosting`.
- Elements whose `itemtype` contains one of those type names.

For link density, traverse text nodes under `root`, skipping hidden/skipped ancestors. Count normalized text characters in all text nodes as denominator and text nodes with an `<a>` ancestor as numerator.

- [ ] **Step 2: Run detector tests**

Run:

```bash
npm test -- tests/article-detector.test.js
```

Expected: PASS.

- [ ] **Step 3: Run extractor regression tests**

Run:

```bash
npm test -- tests/content-extractor.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit detector implementation**

```bash
git add src/article-detector.js tests/article-detector.test.js
git commit -m "feat: add readable article detector"
```

---

### Task 3: Pill Player Visibility and Playability Options

**Files:**

- Modify: `src/pill-player.js`
- Create: `tests/pill-player.test.js`

- [ ] **Step 1: Write failing pill player tests**

Create `tests/pill-player.test.js` with direct `initPillPlayer()` coverage.

```js
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createState } from "../src/state.js";
import { initPillPlayer } from "../src/pill-player.js";

function makeParagraph(text = "Enough words for a playable test paragraph.") {
  const element = document.createElement("p");
  element.textContent = text;
  return {
    element,
    text,
    sentences: [
      {
        text,
        words: text
          .split(/\s+/)
          .map((word, i) => ({
            text: word,
            startOffset: i,
            endOffset: i + word.length,
          })),
      },
    ],
    words: text
      .split(/\s+/)
      .map((word, i) => ({
        text: word,
        startOffset: i,
        endOffset: i + word.length,
      })),
  };
}

async function renderPill(options = {}, paragraphs = [makeParagraph()]) {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  document.body.appendChild(host);
  const state = createState();
  const actions = {
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    skipBack: vi.fn(),
    skipForward: vi.fn(),
  };

  await initPillPlayer(shadow, state, actions, paragraphs, [], options);
  return { shadow, state, actions };
}

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.chrome = {
    storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } },
    runtime: {
      getManifest: vi.fn(() => ({
        name: "Pocket Speechify",
        version: "0.0.0",
      })),
    },
  };
});

describe("initPillPlayer visibility options", () => {
  it("initializes hidden when initiallyVisible is false", async () => {
    const { shadow } = await renderPill({
      initiallyVisible: false,
      hasPlayableContent: true,
    });
    expect(shadow.querySelector(".pill-container").style.display).toBe("none");
  });

  it("initializes visible by default when initiallyVisible is true", async () => {
    const { shadow } = await renderPill({
      initiallyVisible: true,
      hasPlayableContent: true,
    });
    expect(shadow.querySelector(".pill-container").style.display).toBe("");
  });

  it("disables play when hasPlayableContent is false even if paragraphs exist", async () => {
    const { shadow, actions } = await renderPill({
      initiallyVisible: true,
      hasPlayableContent: false,
    });
    const play = shadow.querySelector('[aria-label="Play"]');

    expect(play.classList.contains("btn-disabled")).toBe(true);
    play.click();
    expect(actions.play).not.toHaveBeenCalled();
  });

  it("calls play when hasPlayableContent is true", async () => {
    const { shadow, actions } = await renderPill({
      initiallyVisible: true,
      hasPlayableContent: true,
    });
    shadow.querySelector('[aria-label="Play"]').click();
    expect(actions.play).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run pill tests and verify they fail**

Run:

```bash
npm test -- tests/pill-player.test.js
```

Expected: FAIL because `initPillPlayer()` does not accept or apply the new options yet.

- [ ] **Step 3: Update `src/pill-player.js` API**

Change the signature from:

```js
export async function initPillPlayer(shadow, state, actions, paragraphs, ttsHistory = []) {
  const hasContent = paragraphs.length > 0;
```

to:

```js
export async function initPillPlayer(shadow, state, actions, paragraphs, ttsHistory = [], options = {}) {
  const hasContent = options.hasPlayableContent ?? paragraphs.length > 0;
  const initiallyVisible = options.initiallyVisible ?? true;
```

After creating `pill` and setting its scale, apply initial hidden state:

```js
if (!initiallyVisible) {
  pill.style.display = "none";
}
```

Keep existing `renderIdlePlayButton(hasContent, actions)` behavior so the disabled button remains non-clickable.

- [ ] **Step 4: Run pill tests**

Run:

```bash
npm test -- tests/pill-player.test.js
```

Expected: PASS.

- [ ] **Step 5: Run related tests**

Run:

```bash
npm test -- tests/state.test.js tests/pill-player.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit pill player options**

```bash
git add src/pill-player.js tests/pill-player.test.js
git commit -m "feat: add pill visibility options"
```

---

### Task 4: Content Script Integration

**Files:**

- Modify: `entrypoints/content.js`
- Test: existing detector and pill tests

- [ ] **Step 1: Import detector**

In `entrypoints/content.js`, add:

```js
import { detectReadableArticle } from "../src/article-detector.js";
```

- [ ] **Step 2: Compute detection after extraction**

After:

```js
const paragraphs = extractContent();
log.info(`Extracted ${paragraphs.length} paragraphs`);
```

add:

```js
const articleDetection = detectReadableArticle(document, paragraphs);
const hasPlayableContent =
  articleDetection.isReadableArticle || articleDetection.canPlayBestEffort;
log.info(`Article detection: ${articleDetection.reason}`);
console.log(
  `[Pocket Speechify] Article detection triggered: autoShow=${articleDetection.isReadableArticle}, playable=${hasPlayableContent}, confidence=${articleDetection.confidence.toFixed(2)}`,
);
```

This `console.log` is not a user interaction, but it is useful startup diagnostics and matches the project debugging style.

- [ ] **Step 3: Guard `actions.play()`**

At the start of `actions.play(fromParagraph = 0)`, change:

```js
if (paragraphs.length === 0) {
  log.warn("play: no paragraphs");
  return;
}
```

to:

```js
if (!hasPlayableContent) {
  log.warn("play: page is not playable");
  return;
}
if (paragraphs.length === 0) {
  log.warn("play: no paragraphs");
  return;
}
```

Do not add a user-interaction `console.log` here unless it logs a click handler. The actual play button click is already logged in `src/pill-player.js`.

- [ ] **Step 4: Pass options to pill initialization**

Change:

```js
await initPillPlayer(shadow, state, actions, paragraphs, ttsHistory);
```

to:

```js
await initPillPlayer(shadow, state, actions, paragraphs, ttsHistory, {
  initiallyVisible: articleDetection.isReadableArticle,
  hasPlayableContent,
});
```

- [ ] **Step 5: Gate highlights, hover player, and scroll nav**

Change:

```js
initHighlights(state, paragraphs);

if (paragraphs.length > 0) {
  initHoverPlayer(shadow, state, paragraphs, actions);

  initScrollNav(state, paragraphs);
}
```

to:

```js
if (hasPlayableContent) {
  initHighlights(state, paragraphs);
}

if (articleDetection.isReadableArticle) {
  initHoverPlayer(shadow, state, paragraphs, actions);
  initScrollNav(state, paragraphs);
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- tests/article-detector.test.js tests/pill-player.test.js tests/content-extractor.test.js
```

Expected: PASS.

- [ ] **Step 7: Build extension**

Run:

```bash
npm run build
```

Expected: WXT build completes successfully.

- [ ] **Step 8: Commit content integration**

```bash
git add entrypoints/content.js
git commit -m "feat: gate pill auto-show by article detection"
```

---

### Task 5: Final Verification and Manual Acceptance

**Files:**

- No code changes expected unless verification finds issues.

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run production build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Manual browser smoke test**

Load the built extension or run WXT dev mode. Verify on supported pages:

1. A long article page auto-shows the pill.
2. A homepage/listing-style page initializes with no visible pill.
3. Clicking the extension toolbar icon shows the hidden pill.
4. Clicking the toolbar icon again hides it.
5. On a short/non-playable page, the manually opened pill shows disabled play.
6. On a best-effort prose page that is not article-confident, the manually opened pill can play.
7. On an auto-show article page, paragraph hover player and scroll nav still work.

- [ ] **Step 4: Inspect logging requirement**

Confirm every user interaction touched by this change still logs:

- Play click logs `[Pocket Speechify] Play button clicked`.
- Toolbar icon click logs in `entrypoints/background.js` and content toggle handler.
- Turn Off click logs `[Pocket Speechify] Turn off button clicked`.

No new UI event handlers should be added without `console.log('[Pocket Speechify] <action> clicked/triggered')`.

- [ ] **Step 5: Final status**

Run:

```bash
git status --short
```

Expected: clean working tree after commits, or only intentionally uncommitted generated artifacts that should be ignored.
