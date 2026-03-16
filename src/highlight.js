import { createRangeFromOffsets, scrollToCenter } from './dom-utils.js';

function detectTheme() {
  const bg = getComputedStyle(document.body).backgroundColor;
  const match = bg.match(/\d+/g);
  if (!match) return 'dark';
  const [r, g, b] = match.map(Number);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? 'light' : 'dark';
}

function clearHighlights() {
  document.querySelectorAll('[data-ps-highlight="true"]').forEach(el => el.remove());
}

function createOverlay(rect, color, opacity) {
  const div = document.createElement('div');
  div.setAttribute('data-ps-highlight', 'true');
  div.style.cssText = [
    'position: fixed',
    `top: ${rect.top}px`,
    `left: ${rect.left}px`,
    `width: ${rect.width}px`,
    `height: ${rect.height}px`,
    `background-color: ${color}`,
    `opacity: ${opacity}`,
    'pointer-events: none',
    'border-radius: 3px',
    'z-index: 2147483644',
  ].join('; ');
  return div;
}

let lastSentenceKey = null;
let sentenceOverlays = [];

function updateHighlights(currentState, paragraphs, theme) {
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

  const sentenceColor = theme === 'dark' ? '#444766' : '#e0e3ff';
  const wordColor = theme === 'dark' ? '#5666f0' : '#abb3fe';

  const sentenceKey = `${pIdx}:${sIdx}`;
  const sentenceChanged = sentenceKey !== lastSentenceKey;

  if (sentenceChanged) {
    // Remove old word overlays and old sentence overlays
    clearHighlights();
    sentenceOverlays = [];

    // Sentence highlight: one overlay per client rect
    const sentenceStartOffset = sentence.startOffset;
    const sentenceEndOffset = sentenceStartOffset + sentence.text.length;
    const sentenceRange = createRangeFromOffsets(para.element, sentenceStartOffset, sentenceEndOffset);
    const sentenceRects = sentenceRange.getClientRects();
    for (const rect of sentenceRects) {
      if (rect.width > 0 && rect.height > 0) {
        const overlay = createOverlay(rect, sentenceColor, 0.6);
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

  // Word highlight: one overlay for bounding rect
  const wordRange = createRangeFromOffsets(para.element, word.startOffset, word.endOffset);
  const wordRect = wordRange.getBoundingClientRect();
  if (wordRect.width > 0 && wordRect.height > 0) {
    document.body.appendChild(createOverlay(wordRect, wordColor, 0.6));

    // Auto-scroll: if word is more than 100px outside viewport, smooth-scroll to center it
    const viewportHeight = window.innerHeight;
    if (wordRect.top < -100 || wordRect.bottom > viewportHeight + 100) {
      scrollToCenter(wordRect);
    }
  }
}

export function initHighlights(state, paragraphs) {
  const theme = detectTheme();

  state.subscribe((current, prev) => {
    if (current.playback === 'idle' && prev.playback !== 'idle') {
      clearHighlights();
      lastSentenceKey = null;
      sentenceOverlays = [];
      return;
    }
    if (current.playback === 'playing' || current.playback === 'paused') {
      if (
        current.currentWordIndex !== prev.currentWordIndex ||
        current.currentSentenceIndex !== prev.currentSentenceIndex ||
        current.currentParagraphIndex !== prev.currentParagraphIndex
      ) {
        updateHighlights(current, paragraphs, theme);
      }
    }
  });
}
