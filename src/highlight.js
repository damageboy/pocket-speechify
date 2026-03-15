function detectTheme() {
  const bg = getComputedStyle(document.body).backgroundColor;
  const match = bg.match(/\d+/g);
  if (!match) return 'dark';
  const [r, g, b] = match.map(Number);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? 'light' : 'dark';
}

function createRangeFromOffsets(element, startOffset, endOffset) {
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let charCount = 0;
  let startSet = false;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const nodeLen = node.textContent.length;

    if (!startSet && charCount + nodeLen > startOffset) {
      range.setStart(node, startOffset - charCount);
      startSet = true;
    }
    if (startSet && charCount + nodeLen >= endOffset) {
      range.setEnd(node, endOffset - charCount);
      return range;
    }
    charCount += nodeLen;
  }
  return range;
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

function updateHighlights(currentState, paragraphs, theme) {
  clearHighlights();

  const { currentParagraphIndex: pIdx, currentSentenceIndex: sIdx, currentWordIndex: wIdx } = currentState;

  if (pIdx === null || sIdx === null || wIdx === null) return;

  const para = paragraphs[pIdx];
  if (!para) return;

  const sentence = para.sentences[sIdx];
  if (!sentence) return;

  const word = sentence.words[wIdx];
  if (!word) return;

  const sentenceColor = theme === 'dark' ? '#444766' : '#e0e3ff';
  const wordColor = theme === 'dark' ? '#5666f0' : '#abb3fe';

  // Sentence highlight: one overlay per client rect
  const sentenceStartOffset = sentence.startOffset;
  const sentenceEndOffset = sentenceStartOffset + sentence.text.length;
  const sentenceRange = createRangeFromOffsets(para.element, sentenceStartOffset, sentenceEndOffset);
  const sentenceRects = sentenceRange.getClientRects();
  for (const rect of sentenceRects) {
    if (rect.width > 0 && rect.height > 0) {
      document.body.appendChild(createOverlay(rect, sentenceColor, 0.6));
    }
  }

  // Word highlight: one overlay for bounding rect
  // word.startOffset / word.endOffset are already absolute offsets within paragraph text
  const wordStartOffset = word.startOffset;
  const wordEndOffset = word.endOffset;
  const wordRange = createRangeFromOffsets(para.element, wordStartOffset, wordEndOffset);
  const wordRect = wordRange.getBoundingClientRect();
  if (wordRect.width > 0 && wordRect.height > 0) {
    document.body.appendChild(createOverlay(wordRect, wordColor, 0.6));

    // Auto-scroll: if word is more than 100px outside viewport, smooth-scroll to center it
    const viewportHeight = window.innerHeight;
    if (wordRect.top < -100 || wordRect.bottom > viewportHeight + 100) {
      const absoluteTop = wordRect.top + window.scrollY;
      window.scrollTo({ top: absoluteTop - viewportHeight / 2, behavior: 'smooth' });
    }
  }
}

export function initHighlights(state, paragraphs) {
  const theme = detectTheme();

  state.subscribe((current, prev) => {
    if (current.playback === 'idle' && prev.playback !== 'idle') {
      clearHighlights();
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
