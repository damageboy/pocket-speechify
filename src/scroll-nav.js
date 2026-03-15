function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
  };
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

function makeChevronSVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '17');
  svg.setAttribute('viewBox', '0 0 17 17');
  svg.setAttribute('fill', 'none');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12.7803 6.96967C13.0732 7.26256 13.0732 7.73744 12.7803 8.03033L8.78033 12.0303C8.63968 12.171 8.44891 12.25 8.25 12.25C8.05109 12.25 7.86032 12.171 7.71967 12.0303L3.71967 8.03033C3.42678 7.73744 3.42678 7.26256 3.71967 6.96967C4.01256 6.67678 4.48744 6.67678 4.78033 6.96967L8.25 10.4393L11.7197 6.96967C12.0126 6.67678 12.4874 6.67678 12.7803 6.96967Z');
  path.setAttribute('fill', 'white');
  svg.appendChild(path);

  return svg;
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
  chevronWrapper.appendChild(makeChevronSVG());

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
      const wordStartOffset = sentence.startOffset + word.startOffset;
      const wordEndOffset = sentence.startOffset + word.endOffset;
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

    const absoluteTop = rect.top + window.scrollY;
    window.scrollTo({ top: absoluteTop - window.innerHeight / 2, behavior: 'smooth' });
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
