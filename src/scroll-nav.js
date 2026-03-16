import { createRangeFromOffsets, scrollToCenter } from './dom-utils.js';
import { chevronIcon } from './icons.js';

function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
  };
}

function createPill(isTop) {
  const pill = document.createElement('div');
  pill.setAttribute('data-ps-scrollnav', 'true');
  pill.className = 'scroll-nav ' + (isTop ? 'top' : 'bottom');
  pill.style.cssText = [
    'position: fixed',
    isTop ? 'top: 16px' : 'bottom: 16px',
    'left: 50%',
    'transform: translateX(-50%)',
    'z-index: 2147483646',
    'display: none',
    'opacity: 0',
    'background: #2e2e2e',
    'border-radius: 10px',
    'padding: 4px',
    'flex-direction: row',
    'gap: 2px',
    'align-items: center',
    'cursor: pointer',
    'pointer-events: auto',
  ].join('; ');

  const chevronWrapper = document.createElement('div');
  chevronWrapper.style.cssText = [
    'width: 17px',
    'height: 17px',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    isTop ? 'transform: rotate(180deg)' : '',
  ].filter(Boolean).join('; ');
  chevronWrapper.appendChild(chevronIcon());

  const wordBadge = document.createElement('div');
  wordBadge.className = 'scroll-nav-word';
  wordBadge.style.cssText = [
    'background: #5666f0',
    'border-radius: 6px',
    'padding: 4px 6px',
    'color: white',
    'font: 500 14px system-ui',
    'white-space: nowrap',
  ].join('; ');

  pill.appendChild(chevronWrapper);
  pill.appendChild(wordBadge);

  return { pill, wordBadge };
}

function showPill(pill) {
  pill.style.display = 'flex';
  pill.style.opacity = '1';
}

function hidePill(pill) {
  pill.style.display = 'none';
  pill.style.opacity = '0';
}

export function initScrollNav(state, paragraphs) {
  const { pill: topPill, wordBadge: topBadge } = createPill(true);
  const { pill: bottomPill, wordBadge: bottomBadge } = createPill(false);

  document.body.appendChild(topPill);
  document.body.appendChild(bottomPill);

  function getHighlightRect() {
    const { currentParagraphIndex: pIdx, currentSentenceIndex: sIdx, currentWordIndex: wIdx } = state.get();
    if (pIdx === null || sIdx === null || wIdx === null) return null;

    const para = paragraphs[pIdx];
    if (!para) return null;

    const sentence = para.sentences[sIdx];
    if (!sentence) return null;

    const word = sentence.words[wIdx];
    if (!word) return null;

    try {
      // word.startOffset / word.endOffset are already absolute offsets within paragraph text
      const wordStartOffset = word.startOffset;
      const wordEndOffset = word.endOffset;
      const range = createRangeFromOffsets(para.element, wordStartOffset, wordEndOffset);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) return rect;
    } catch (_) {
      // fall back to paragraph rect
    }

    return para.element.getBoundingClientRect();
  }

  function getCurrentWordText() {
    const { currentParagraphIndex: pIdx, currentSentenceIndex: sIdx, currentWordIndex: wIdx } = state.get();
    if (pIdx === null || sIdx === null || wIdx === null) return '';

    const para = paragraphs[pIdx];
    if (!para) return '';

    const sentence = para.sentences[sIdx];
    if (!sentence) return '';

    const word = sentence.words[wIdx];
    if (!word) return '';

    return word.text || '';
  }

  function updateBadgeText() {
    const text = getCurrentWordText();
    topBadge.textContent = text;
    bottomBadge.textContent = text;
  }

  function checkVisibility() {
    const { playback } = state.get();
    if (playback !== 'playing') return;

    const rect = getHighlightRect();
    if (!rect) {
      hidePill(topPill);
      hidePill(bottomPill);
      return;
    }

    const vpHeight = window.innerHeight;

    if (rect.bottom < 0) {
      // Highlight is above viewport
      showPill(topPill);
      hidePill(bottomPill);
    } else if (rect.top > vpHeight) {
      // Highlight is below viewport
      hidePill(topPill);
      showPill(bottomPill);
    } else {
      // Highlight is in viewport
      hidePill(topPill);
      hidePill(bottomPill);
    }
  }

  function scrollToHighlight() {
    const rect = getHighlightRect();
    if (!rect) return;

    scrollToCenter(rect);
    hidePill(topPill);
    hidePill(bottomPill);
  }

  topPill.addEventListener('click', scrollToHighlight);
  bottomPill.addEventListener('click', scrollToHighlight);

  const throttledCheck = throttle(checkVisibility, 100);
  window.addEventListener('scroll', throttledCheck, { passive: true });

  state.subscribe((current, prev) => {
    if (current.playback === 'idle') {
      hidePill(topPill);
      hidePill(bottomPill);
      return;
    }

    if (
      current.currentWordIndex !== prev.currentWordIndex ||
      current.currentSentenceIndex !== prev.currentSentenceIndex ||
      current.currentParagraphIndex !== prev.currentParagraphIndex
    ) {
      updateBadgeText();
      // Re-check visibility when word changes (highlight may have moved)
      if (current.playback === 'playing') {
        throttledCheck();
      }
    }
  });
}
