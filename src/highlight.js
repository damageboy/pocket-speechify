import { createRangeFromOffsets, scrollToCenter } from './dom-utils.js';

/**
 * Resolve the effective background color of an element by walking up
 * the DOM tree until we find a non-transparent background.
 */
function getEffectiveBackground(el) {
  let node = el;
  while (node && node !== document.documentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    const match = bg.match(/\d+/g);
    if (match) {
      const [r, g, b, a] = match.map(Number);
      // If alpha is 0 or rgba with 0 alpha, keep walking
      if (a !== 0 && (r + g + b > 0 || a === undefined)) {
        return { r, g, b };
      }
    }
    node = node.parentElement;
  }
  // Default: assume white
  return { r: 255, g: 255, b: 255 };
}

/**
 * Compute luminance (0-1) from RGB.
 */
function luminance({ r, g, b }) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Derive highlight colors dynamically from the paragraph's background.
 * - Light backgrounds: blue-tinted overlay that's visible but not harsh
 * - Dark backgrounds: lighter blue overlay
 * Returns { sentenceColor, wordColor, opacity }
 */
function deriveHighlightColors(bgColor) {
  const lum = luminance(bgColor);

  if (lum > 0.5) {
    // Light background — use semi-transparent blue overlays
    return {
      sentenceColor: 'rgba(171, 179, 254, 0.35)', // soft blue, visible on light
      wordColor: 'rgba(86, 102, 240, 0.30)',       // brighter blue for word
      opacity: 1, // opacity baked into rgba
    };
  } else {
    // Dark background — use the Speechify dark theme colors
    return {
      sentenceColor: 'rgba(68, 71, 102, 0.6)',     // #444766 at 60%
      wordColor: 'rgba(86, 102, 240, 0.6)',         // #5666f0 at 60%
      opacity: 1,
    };
  }
}

function clearHighlights() {
  document.querySelectorAll('[data-ps-highlight="true"]').forEach(el => el.remove());
}

function createOverlay(rect, color) {
  const div = document.createElement('div');
  div.setAttribute('data-ps-highlight', 'true');
  div.style.cssText = [
    'position: fixed',
    `top: ${rect.top}px`,
    `left: ${rect.left}px`,
    `width: ${rect.width}px`,
    `height: ${rect.height}px`,
    `background-color: ${color}`,
    'pointer-events: none',
    'border-radius: 3px',
    'z-index: 2147483644',
    'mix-blend-mode: multiply',
  ].join('; ');
  return div;
}

let lastSentenceKey = null;
let sentenceOverlays = [];
let cachedColors = null;
let cachedColorParaIdx = null;

function updateHighlights(currentState, paragraphs) {
  const { currentParagraphIndex: pIdx, currentSentenceIndex: sIdx, currentWordIndex: wIdx } = currentState;

  if (pIdx === null || sIdx === null || wIdx === null) {
    clearHighlights();
    lastSentenceKey = null;
    sentenceOverlays = [];
    return;
  }

  const para = paragraphs[pIdx];
  if (!para) { clearHighlights(); lastSentenceKey = null; sentenceOverlays = []; return; }

  const sentence = para.sentences[sIdx];
  if (!sentence) { clearHighlights(); lastSentenceKey = null; sentenceOverlays = []; return; }

  const word = sentence.words[wIdx];
  if (!word) { clearHighlights(); lastSentenceKey = null; sentenceOverlays = []; return; }

  // Derive colors from paragraph background (cached per paragraph)
  if (cachedColorParaIdx !== pIdx) {
    const bgColor = getEffectiveBackground(para.element);
    cachedColors = deriveHighlightColors(bgColor);
    cachedColorParaIdx = pIdx;
  }
  const { sentenceColor, wordColor } = cachedColors;

  const sentenceKey = `${pIdx}:${sIdx}`;
  const sentenceChanged = sentenceKey !== lastSentenceKey;

  if (sentenceChanged) {
    clearHighlights();
    sentenceOverlays = [];

    // Sentence highlight: merge overlapping/adjacent rects to avoid gaps at inline element boundaries
    const sentenceStartOffset = sentence.startOffset;
    const sentenceEndOffset = sentenceStartOffset + sentence.text.length;
    const sentenceRange = createRangeFromOffsets(para.element, sentenceStartOffset, sentenceEndOffset);
    const rawRects = Array.from(sentenceRange.getClientRects());
    const mergedRects = mergeRects(rawRects);

    for (const rect of mergedRects) {
      if (rect.width > 0 && rect.height > 0) {
        const overlay = createOverlay(rect, sentenceColor);
        document.body.appendChild(overlay);
        sentenceOverlays.push(overlay);
      }
    }
    lastSentenceKey = sentenceKey;
  } else {
    // Remove only word overlays (those not in sentenceOverlays)
    document.querySelectorAll('[data-ps-highlight="true"]').forEach(el => {
      if (!sentenceOverlays.includes(el)) el.remove();
    });
  }

  // Word highlight
  const wordRange = createRangeFromOffsets(para.element, word.startOffset, word.endOffset);
  const wordRect = wordRange.getBoundingClientRect();
  if (wordRect.width > 0 && wordRect.height > 0) {
    document.body.appendChild(createOverlay(wordRect, wordColor));

    // Auto-scroll if word is far outside viewport
    const viewportHeight = window.innerHeight;
    if (wordRect.top < -100 || wordRect.bottom > viewportHeight + 100) {
      scrollToCenter(wordRect);
    }
  }
}

/**
 * Merge client rects that are on the same line (overlapping or adjacent vertically).
 * This prevents visible seams between inline elements (italic, links, etc.)
 * by combining rects that share the same approximate vertical position into one wide rect.
 */
function mergeRects(rects) {
  if (rects.length === 0) return [];

  // Sort by top, then left
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const merged = [];
  let current = { top: sorted[0].top, left: sorted[0].left, right: sorted[0].right, bottom: sorted[0].bottom };

  for (let i = 1; i < sorted.length; i++) {
    const rect = sorted[i];
    // Same line: vertical overlap > 50% of the shorter rect's height
    const overlapThreshold = Math.min(current.bottom - current.top, rect.bottom - rect.top) * 0.5;
    const verticalOverlap = Math.min(current.bottom, rect.bottom) - Math.max(current.top, rect.top);

    if (verticalOverlap >= overlapThreshold && rect.left <= current.right + 2) {
      // Merge: extend current rect
      current.right = Math.max(current.right, rect.right);
      current.top = Math.min(current.top, rect.top);
      current.bottom = Math.max(current.bottom, rect.bottom);
    } else {
      // New line — push current and start a new one
      merged.push(current);
      current = { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom };
    }
  }
  merged.push(current);

  // Convert to DOMRect-like objects
  return merged.map(r => ({
    top: r.top,
    left: r.left,
    width: r.right - r.left,
    height: r.bottom - r.top,
  }));
}

export function initHighlights(state, paragraphs) {
  state.subscribe((current, prev) => {
    if (current.playback === 'idle' && prev.playback !== 'idle') {
      clearHighlights();
      lastSentenceKey = null;
      sentenceOverlays = [];
      cachedColorParaIdx = null;
      return;
    }
    if (current.playback === 'playing' || current.playback === 'paused') {
      if (
        current.currentWordIndex !== prev.currentWordIndex ||
        current.currentSentenceIndex !== prev.currentSentenceIndex ||
        current.currentParagraphIndex !== prev.currentParagraphIndex
      ) {
        updateHighlights(current, paragraphs);
      }
    }
  });
}
