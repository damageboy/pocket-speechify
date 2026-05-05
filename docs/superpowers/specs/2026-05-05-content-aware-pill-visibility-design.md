# Content-Aware Pill Visibility Design

## Goal

The pill player should not automatically appear on pages that are unlikely to contain a readable article, such as front pages, search/listing pages, or media-heavy pages. The extension content script should still load, and clicking the browser extension icon should manually show or hide the pill on any page.

## Chosen Approach

Use a readability-style heuristic scorer. This avoids site-specific allow/deny lists for the first version while still being more reliable than a simple paragraph count.

## Behavior

- On likely article pages, the pill is visible by default.
- On unlikely article pages, the pill is injected but hidden by default.
- Clicking the extension icon toggles the pill on any supported page where the content script runs, regardless of the detector result.
- Manual toggle state is page-instance local for v1. It is not persisted across full reloads, new tabs, or sites. SPA route changes may retain the current state because SPA re-detection is out of scope.
- If the pill is manually opened on a non-article page, playback is best-effort only when there is enough extracted prose to read.
- If there is not enough prose, the play button remains disabled.
- No host-specific special cases are included initially. Allow/deny lists can be added later if needed.
- V1 detection runs once at `document_idle`. SPA route changes and later DOM mutations are out of scope for this first pass.

## Article Detection Signals and Thresholds

The detector separates **prose-like blocks** from all extracted blocks. Prose-like blocks are visible extracted blocks whose source element is `P`, `BLOCKQUOTE`, or a qualifying heading, and whose text has at least 40 characters and at least 8 words. A qualifying heading is an `H1`–`H6` block that also contains at least one sentence-ending punctuation mark (`.`, `!`, or `?`). `LI` blocks do not count toward article auto-show, because homepages and navigation pages often contain many list items.

Initial numeric thresholds:

- Long prose block: at least 80 characters and at least 15 words.
- Auto-show article threshold: at least 300 prose words and at least 3 long prose blocks.
- Best-effort playback threshold: at least 120 prose words and at least 2 prose-like blocks.
- Low link density: visible linked text characters / visible candidate-root text characters is below 0.35.
- High link density: visible linked text characters / visible candidate-root text characters is at or above 0.50.
- Confidence range: `0.0` to `1.0`; auto-show requires confidence at or above `0.65`.

Candidate root selection for link density and structural signals:

1. Build candidates from visible `<article>` elements, visible `<main>` elements, and `document.body`.
2. For each candidate, compute prose word count, prose-like block count, and long prose block count using only extracted blocks contained by that candidate. Compute link density from the candidate root DOM subtree, excluding hidden/skipped regions. Then compute confidence for that candidate.
3. Select the candidate with the highest confidence; break ties by higher prose word count.
4. All `isReadableArticle` and `canPlayBestEffort` thresholds are evaluated against the selected candidate root, not against all page text.

Visibility and skipped-region rules:

- A candidate or block is visible when it has layout boxes (`getClientRects().length > 0`) and is not under an element with `aria-hidden="true"`.
- Detector unit tests should either stub layout visibility APIs or the detector should accept an injectable visibility predicate so Happy DOM/JSDOM tests can be deterministic.
- Exclude text under `NAV`, `FOOTER`, `HEADER`, `ASIDE`, `SCRIPT`, `STYLE`, and `NOSCRIPT`, matching the current extractor's skip intent.

Link density calculation:

- Use visible text only.
- Use character counts after collapsing whitespace to single spaces and trimming.
- Numerator: visible text characters inside `<a>` elements contained by the selected candidate root after applying the skipped-region rules.
- Denominator: all visible text characters contained by the selected candidate root after applying the skipped-region rules.
- If the denominator is `0`, link density is `1.0`.

V1 schema detection supports JSON-LD `<script type="application/ld+json">` where `@type` is a string or array containing `Article`, `NewsArticle`, or `BlogPosting`, plus visible elements with `itemtype` containing those schema.org type names.

Deterministic confidence formula:

- Start at `0`.
- Add `0.25` if article metadata is present: `og:type=article`, supported JSON-LD type, or supported `itemtype`.
- Add `0.20` if the selected candidate root is `<article>`.
- Add `0.10` if the selected candidate root is `<main>`.
- Add `0.20` if prose word count is at least 300.
- Add `0.20` more if prose word count is at least 600.
- Add `0.20` if there are at least 3 long prose blocks.
- Add `0.10` if link density is below 0.35.
- Subtract `0.25` if link density is at or above 0.50.
- Clamp the final value to `0.0..1.0`.

`isReadableArticle` is true only when all of these are true:

- Confidence is at least `0.65`.
- Prose word count is at least 300.
- Long prose block count is at least 3.
- Link density is below 0.50.

`canPlayBestEffort` is true when all of these are true:

- Prose word count is at least 120.
- Prose-like block count is at least 2.

Best-effort intentionally does not require low link density. Manual icon-open should permit reading when enough prose exists, even if the surrounding page is too link-heavy to auto-show.

`isReadableArticle: true` always implies `canPlayBestEffort: true`.

Positive signals:

- A visible `<article>` element exists and passes the prose/link-density thresholds.
- A meaningful `<main>` element contains substantial prose.
- `meta[property="og:type"]` is `article`.
- JSON-LD or schema.org markup indicates `Article`, `NewsArticle`, or `BlogPosting`.
- The page contains multiple long prose blocks.
- Total visible prose word count passes the auto-show threshold.
- Candidate content has low link density.

Negative signals:

- High link density.
- Text is mostly headings, links, lists, or cards.
- Too little continuous prose.
- Extracted text does not pass the lower best-effort playback threshold.

## Proposed Module Boundary

Add `src/article-detector.js` with a function shaped like:

```js
export function detectReadableArticle(document, paragraphs) {
  return {
    isReadableArticle: boolean,
    canPlayBestEffort: boolean,
    confidence: number,
    reason: string,
    proseParagraphIndexes: number[],
  };
}
```

The detector decides default visibility and manual-play eligibility. `content-extractor.js` remains responsible for extracting readable blocks. Playback continues to use the existing full `paragraphs` array for v1 once the page passes either the auto-show or best-effort threshold, including extracted blocks outside the selected candidate root. This means v1 may still read headings, list items, or blockquotes included by the existing extractor after the page passes prose-based eligibility. That behavior is accepted for v1 to keep this change focused on default visibility; `proseParagraphIndexes` is returned for diagnostics and future filtering.

## Content Script Flow

1. Extract page content with `extractContent()`.
2. Score the page with `detectReadableArticle(document, paragraphs)`.
3. Initialize the pill with explicit visibility/playability options:

   ```js
   initPillPlayer(shadow, state, actions, paragraphs, ttsHistory, {
     initiallyVisible: detection.isReadableArticle,
     hasPlayableContent: detection.isReadableArticle || detection.canPlayBestEffort,
   });
   ```

   `initiallyVisible: false` initializes `.pill-container` hidden via the same mechanism used by toolbar toggling. V1 may keep using `style.display = 'none'`; if a CSS class is introduced, toolbar toggle and turn-off should use that shared class consistently.

4. Enable play when `detection.isReadableArticle || detection.canPlayBestEffort`.
5. Initialize hover player and scroll navigation only when `detection.isReadableArticle` is true. This prevents hover play buttons from appearing on pages where the pill is hidden by default. Manual icon-open on a best-effort page shows only the pill controls in v1.
6. Initialize highlights whenever `hasPlayableContent` is true, so manual best-effort playback still highlights read text.
7. Keep toolbar icon handling as a manual toggle independent of detector result.
8. Guard `actions.play()` with the same `hasPlayableContent` boolean used by the UI. The disabled play button is not the only protection.

## Testing Strategy

Add unit tests for the detector using synthetic DOM fixtures:

- Article page with metadata and long paragraphs: auto-show true.
- Homepage/card grid with many links: auto-show false.
- Short page with little text: auto-show false and best-effort false.
- Long body-only prose page without metadata: auto-show true when prose is strong enough to satisfy the deterministic confidence formula.
- Mixed page with enough text but weaker confidence: auto-show false but best-effort true.

Add or update integration-level tests around content initialization if existing test patterns support it. Acceptance coverage should include:

- Non-article page initializes the pill hidden.
- Toolbar icon message shows and hides the pill.
- Play button is disabled when `hasPlayableContent=false`.
- `actions.play()` guard prevents playback when called directly on a non-playable page.
