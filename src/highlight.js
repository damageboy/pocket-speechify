import { createRangeFromOffsets, isProgrammaticScroll, scrollToCenter } from './dom-utils.js';

const PARAGRAPH_HIGHLIGHT = 'pocket-speechify-paragraph';
const WORD_HIGHLIGHT = 'pocket-speechify-word';
const AUTO_SCROLL_MARGIN_PX = 60;
let autoScrollEnabled = true;

function isDarkBackground(element) {
  for (let node = element; node; node = node.parentElement) {
    const match = getComputedStyle(node).backgroundColor.match(/[\d.]+/g);
    if (!match) continue;
    const [r, g, b, a = 1] = match.map(Number);
    if (a > 0) return (0.299 * r + 0.587 * g + 0.114 * b) / 255 <= 0.5;
  }
  return false;
}

/** Re-enable following after the user clicks scroll-to-highlight. */
export function enableAutoScroll() {
  autoScrollEnabled = true;
}

export function initHighlights(state, paragraphs) {
  // Native ranges follow layout, transforms, line wrapping and scroll clipping.
  // No positioned overlays or geometry invalidation are needed.
  const style = document.createElement('style');
  style.dataset.psHighlight = 'style';
  document.head.appendChild(style);
  let lastParagraph = null;

  function clear() {
    CSS.highlights.delete(PARAGRAPH_HIGHLIGHT);
    CSS.highlights.delete(WORD_HIGHLIGHT);
    lastParagraph = null;
  }

  function update(current, follow = false) {
    const paragraph = current.currentParagraphIndex === null ? null : paragraphs[current.currentParagraphIndex];
    if (current.playback === 'idle' || !paragraph) {
      clear();
      return;
    }

    if (lastParagraph !== paragraph) {
      clear();
      const dark = isDarkBackground(paragraph.element);
      style.textContent = `
        ::highlight(${PARAGRAPH_HIGHLIGHT}) { background-color: ${dark ? '#444766' : '#e0e3ff'}; }
        ::highlight(${WORD_HIGHLIGHT}) { background-color: ${dark ? '#5666f0' : '#abb3fe'}; }
      `;
      const range = createRangeFromOffsets(paragraph.element, paragraph.startOffset, paragraph.endOffset);
      if (range) {
        const highlight = new Highlight(range);
        highlight.priority = 0;
        CSS.highlights.set(PARAGRAPH_HIGHLIGHT, highlight);
      }
      lastParagraph = paragraph;
    }

    CSS.highlights.delete(WORD_HIGHLIGHT);
    const word = paragraph.words[current.currentWordIndex];
    if (!word) return; // Native timestamp gaps leave only the paragraph highlighted.
    const range = createRangeFromOffsets(paragraph.element, word.startOffset, word.endOffset);
    if (!range) return;
    const highlight = new Highlight(range);
    highlight.priority = 1;
    CSS.highlights.set(WORD_HIGHLIGHT, highlight);

    if (follow && autoScrollEnabled && !isProgrammaticScroll()) {
      const rect = range.getBoundingClientRect();
      if (rect.height > 0 && (rect.top < AUTO_SCROLL_MARGIN_PX ||
          rect.bottom > window.innerHeight - AUTO_SCROLL_MARGIN_PX)) scrollToCenter(rect);
    }
  }

  function onScroll() {
    if (isProgrammaticScroll() || !autoScrollEnabled) return;
    console.log('[Pocket Speechify] User scroll triggered — auto-scroll disabled');
    autoScrollEnabled = false;
  }
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  const unsubscribe = state.subscribe((current, prev) => {
    if (current.playback === 'idle') {
      clear();
      autoScrollEnabled = true;
    } else if (current.currentWordIndex !== prev.currentWordIndex ||
        current.currentParagraphIndex !== prev.currentParagraphIndex) {
      update(current, true);
    }
  });

  return {
    // A source refresh may replace DOM text nodes without changing indices.
    refresh() { lastParagraph = null; update(state.get()); },
    destroy() {
      unsubscribe();
      window.removeEventListener('scroll', onScroll, true);
      clear();
      style.remove();
    },
  };
}
