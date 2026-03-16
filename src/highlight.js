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
      if (a !== 0 && (r + g + b > 0 || a === undefined)) {
        return { r, g, b };
      }
    }
    node = node.parentElement;
  }
  return { r: 255, g: 255, b: 255 };
}

function luminance({ r, g, b }) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function deriveHighlightColors(bgColor) {
  const lum = luminance(bgColor);
  if (lum > 0.5) {
    return {
      sentenceColor: 'rgba(171, 179, 254, 0.35)',
      wordColor: 'rgba(86, 102, 240, 0.30)',
    };
  } else {
    return {
      sentenceColor: 'rgba(68, 71, 102, 0.6)',
      wordColor: 'rgba(86, 102, 240, 0.6)',
    };
  }
}

function clearHighlights() {
  document.querySelectorAll('[data-ps-highlight="true"]').forEach(el => el.remove());
}

/**
 * Create an overlay positioned in document coordinates (position: absolute).
 * Rects from getBoundingClientRect() are viewport-relative, so we add scroll offsets.
 */
function createOverlay(rect, color) {
  const div = document.createElement('div');
  div.setAttribute('data-ps-highlight', 'true');
  div.style.cssText = [
    'position: absolute',
    `top: ${rect.top + window.scrollY}px`,
    `left: ${rect.left + window.scrollX}px`,
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

// --- Auto-scroll control ---
// Auto-scroll is disabled as soon as the user manually scrolls.
// It only re-enables when the user explicitly clicks the scroll-nav widget
// or when playback resets to idle.
let autoScrollEnabled = true;
let lastProgrammaticScroll = false;

function onUserScroll() {
  if (lastProgrammaticScroll) {
    lastProgrammaticScroll = false;
    return;
  }
  autoScrollEnabled = false;
}

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

    // Auto-scroll only if enabled (user hasn't scrolled away recently)
    if (autoScrollEnabled) {
      const viewportHeight = window.innerHeight;
      if (wordRect.top < -100 || wordRect.bottom > viewportHeight + 100) {
        lastProgrammaticScroll = true;
        scrollToCenter(wordRect);
      }
    }
  }
}

/**
 * Merge client rects on the same line to eliminate seams at inline element boundaries.
 */
function mergeRects(rects) {
  if (rects.length === 0) return [];

  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const merged = [];
  let current = { top: sorted[0].top, left: sorted[0].left, right: sorted[0].right, bottom: sorted[0].bottom };

  for (let i = 1; i < sorted.length; i++) {
    const rect = sorted[i];
    const overlapThreshold = Math.min(current.bottom - current.top, rect.bottom - rect.top) * 0.5;
    const verticalOverlap = Math.min(current.bottom, rect.bottom) - Math.max(current.top, rect.top);

    if (verticalOverlap >= overlapThreshold && rect.left <= current.right + 2) {
      current.right = Math.max(current.right, rect.right);
      current.top = Math.min(current.top, rect.top);
      current.bottom = Math.max(current.bottom, rect.bottom);
    } else {
      merged.push(current);
      current = { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom };
    }
  }
  merged.push(current);

  return merged.map(r => ({
    top: r.top,
    left: r.left,
    width: r.right - r.left,
    height: r.bottom - r.top,
  }));
}

/** Re-enable auto-scroll (called by scroll-nav when user clicks to scroll back) */
export function enableAutoScroll() {
  autoScrollEnabled = true;
}

export function initHighlights(state, paragraphs) {
  // Listen for user scroll to disable auto-scroll temporarily
  window.addEventListener('scroll', onUserScroll, { passive: true });

  state.subscribe((current, prev) => {
    if (current.playback === 'idle' && prev.playback !== 'idle') {
      clearHighlights();
      lastSentenceKey = null;
      sentenceOverlays = [];
      cachedColorParaIdx = null;
      autoScrollEnabled = true;
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
