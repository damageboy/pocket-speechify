import { createRangeFromOffsets, isProgrammaticScroll, scrollToCenter } from './dom-utils.js';
import { highlightColors } from './highlight-colors.js';

const PARAGRAPH_HIGHLIGHT = 'pocket-speechify-paragraph';
const WORD_HIGHLIGHT = 'pocket-speechify-word';
const AUTO_SCROLL_MARGIN_PX = 60;
let autoScrollEnabled = true;

/** Re-enable following after the user clicks scroll-to-highlight. */
export function enableAutoScroll() {
  autoScrollEnabled = true;
}

function shouldFollow(follow) {
  return follow && autoScrollEnabled && !isProgrammaticScroll();
}

// Native ranges follow layout, transforms, line wrapping and scroll clipping.
// No positioned overlays or geometry invalidation are needed.
function createRangePainter(paragraphs) {
  const style = document.createElement('style');
  style.dataset.psHighlight = 'style';
  document.head.appendChild(style);
  let lastParagraph = null;
  let paragraphRange = null;

  function clear() {
    CSS.highlights.delete(PARAGRAPH_HIGHLIGHT);
    CSS.highlights.delete(WORD_HIGHLIGHT);
    lastParagraph = null;
    paragraphRange = null;
  }

  function update(current, follow = false) {
    const paragraph = current.currentParagraphIndex === null ? null : paragraphs[current.currentParagraphIndex];
    if (current.playback === 'idle' || !paragraph) {
      clear();
      return;
    }

    if (lastParagraph !== paragraph) {
      clear();
      paragraphRange = createRangeFromOffsets(paragraph.element, paragraph.startOffset, paragraph.endOffset);
      if (paragraphRange) {
        const highlight = new Highlight(paragraphRange);
        highlight.priority = 0;
        CSS.highlights.set(PARAGRAPH_HIGHLIGHT, highlight);
      }
      lastParagraph = paragraph;
    }

    // Recheck on word boundaries so a page theme change cannot leave a stale
    // palette behind. Keep the native paragraph range and avoid unchanged CSS writes.
    if (paragraphRange) {
      const colors = highlightColors(paragraphRange);
      const css = `
        ::highlight(${PARAGRAPH_HIGHLIGHT}) {
          background-color: ${colors.paragraph};
          text-decoration: ${colors.paragraph === 'transparent' ? 'underline currentColor' : 'none'};
        }
        ::highlight(${WORD_HIGHLIGHT}) {
          background-color: ${colors.word};
          text-decoration: ${colors.underline ? 'underline double currentColor' : 'none'};
        }
      `;
      if (style.textContent !== css) style.textContent = css;
    }

    CSS.highlights.delete(WORD_HIGHLIGHT);
    const word = paragraph.words[current.currentWordIndex];
    if (!word) return; // Native timestamp gaps leave only the paragraph highlighted.
    const range = createRangeFromOffsets(paragraph.element, word.startOffset, word.endOffset);
    if (!range) return;
    const highlight = new Highlight(range);
    highlight.priority = 1;
    CSS.highlights.set(WORD_HIGHLIGHT, highlight);

    if (shouldFollow(follow)) {
      const rect = range.getBoundingClientRect();
      if (rect.height > 0 && (rect.top < AUTO_SCROLL_MARGIN_PX ||
          rect.bottom > window.innerHeight - AUTO_SCROLL_MARGIN_PX)) scrollToCenter(rect);
    }
  }

  return {
    update,
    // A source refresh may replace DOM text nodes without changing indices.
    refresh(current) { lastParagraph = null; update(current); },
    destroy() { clear(); style.remove(); },
  };
}

// Canvas-rendered text (Google Docs) has no DOM text to range over. Paint
// boxes from the source geometry into a layer clipped to the editor viewport;
// multiply blending keeps the canvas text readable underneath.
function createOverlayPainter(state, paragraphs, geometry) {
  const layer = document.createElement('div');
  layer.dataset.psHighlight = 'layer';
  // The fixed layer is its own stacking context, so it must do the blending:
  // blend modes on its children would only mix with the empty layer.
  layer.style.cssText = 'position:fixed;overflow:hidden;pointer-events:none;z-index:2147483640;mix-blend-mode:multiply;';
  document.body.appendChild(layer);
  let frame = null;

  function paint(boxes, color, view) {
    for (const box of boxes) {
      const div = document.createElement('div');
      div.style.cssText = `position:absolute;left:${box.left - view.left}px;top:${box.top - view.top}px;` +
        `width:${box.width}px;height:${box.height}px;background:${color};`;
      layer.appendChild(div);
    }
  }

  // Style runs on one line become one box, so spaces between runs are covered.
  function mergeLines(boxes) {
    const lines = [];
    for (const box of boxes) {
      const line = lines.find(other => Math.abs(other.top - box.top) < 1 && Math.abs(other.bottom - box.bottom) < 1);
      if (!line) lines.push({ ...box });
      else {
        line.left = Math.min(line.left, box.left);
        line.right = Math.max(line.right, box.right);
        line.width = line.right - line.left;
      }
    }
    return lines;
  }

  function update(current, follow = false) {
    layer.replaceChildren();
    const index = current.currentParagraphIndex;
    const paragraph = index === null ? null : paragraphs[index];
    if (current.playback === 'idle' || !paragraph) return;
    const view = geometry.viewport();
    Object.assign(layer.style, {
      left: `${view.left}px`, top: `${view.top}px`, width: `${view.width}px`, height: `${view.height}px`,
    });
    paint(mergeLines(geometry.rangeRects(index, paragraph.startOffset, paragraph.endOffset)), '#e0e3ff', view);
    const word = paragraph.words[current.currentWordIndex];
    if (!word) return;
    paint(geometry.rangeRects(index, word.startOffset, word.endOffset), '#abb3fe', view);

    if (shouldFollow(follow)) {
      const rect = geometry.locate(index, word.startOffset, word.endOffset);
      if (rect && (rect.estimated || rect.top < view.top + AUTO_SCROLL_MARGIN_PX ||
          rect.bottom > view.bottom - AUTO_SCROLL_MARGIN_PX)) scrollToCenter(rect, geometry.scroller());
    }
  }

  // Scrolling and Docs re-rendering move the text under a static layer.
  function schedule() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      update(state.get());
    });
  }
  const unsubscribe = geometry.onChange(schedule);
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('resize', schedule);

  return {
    update,
    refresh: update,
    destroy() {
      cancelAnimationFrame(frame);
      unsubscribe();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      layer.remove();
    },
  };
}

export function initHighlights(state, paragraphs, geometry = null) {
  const painter = geometry ? createOverlayPainter(state, paragraphs, geometry) : createRangePainter(paragraphs);

  function onScroll() {
    // Scrolling to find a start position must not disable following for the
    // playback it then starts.
    if (isProgrammaticScroll() || !autoScrollEnabled || state.get().playback === 'idle') return;
    console.log('[Pocket Speechify] User scroll triggered — auto-scroll disabled');
    autoScrollEnabled = false;
  }
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  const unsubscribe = state.subscribe((current, prev) => {
    if (current.playback === 'idle') {
      painter.update(current);
      autoScrollEnabled = true;
    } else if (current.currentWordIndex !== prev.currentWordIndex ||
        current.currentParagraphIndex !== prev.currentParagraphIndex) {
      painter.update(current, true);
    }
  });

  return {
    refresh() { painter.refresh(state.get()); },
    destroy() {
      unsubscribe();
      window.removeEventListener('scroll', onScroll, true);
      painter.destroy();
    },
  };
}
