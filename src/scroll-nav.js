import { createRangeFromOffsets, scrollToCenter } from './dom-utils.js';
import { chevronIcon } from './icons.js';
import { enableAutoScroll } from './highlight.js';

// Throttle with a trailing call, so the final scroll position is always checked.
function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return () => {
    const wait = ms - (Date.now() - last);
    if (wait <= 0) {
      last = Date.now();
      fn();
    } else if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn();
      }, wait);
    }
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

  // currentWordIndex indexes the paragraph's words, not the sentence's. It is
  // null in the silence between words; fall back to the paragraph then.
  function getCurrent() {
    const { currentParagraphIndex: pIdx, currentWordIndex: wIdx } = state.get();
    const para = pIdx === null ? null : paragraphs[pIdx];
    if (!para) return null;
    return { para, word: wIdx === null ? null : para.words[wIdx] || null };
  }

  function getHighlightRect() {
    const current = getCurrent();
    if (!current) return null;
    const { para, word } = current;
    const rect = word &&
      createRangeFromOffsets(para.element, word.startOffset, word.endOffset)?.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) return rect;
    return para.element.getBoundingClientRect();
  }

  function updateBadgeText() {
    const text = getCurrent()?.word?.text;
    if (!text) return; // keep the last word through silences
    topBadge.textContent = text;
    bottomBadge.textContent = text;
  }

  function checkVisibility() {
    if (state.get().playback === 'idle') return;

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
    console.log('[Pocket Speechify] Scroll-nav clicked — scrolling to highlight');
    const rect = getHighlightRect();
    if (!rect) return;

    enableAutoScroll(); // re-enable auto-scroll since user explicitly asked to go back
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
      throttledCheck();
    }
  });
}
