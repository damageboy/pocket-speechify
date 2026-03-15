import { hoverPlayIcon } from './icons.js';

export function initHoverPlayer(shadow, state, paragraphs, actions) {
  // Create a single reusable hover button in the shadow root
  const btn = document.createElement('button');
  btn.className = 'hover-player';
  btn.style.display = 'none';
  btn.style.pointerEvents = 'auto';
  btn.setAttribute('aria-label', 'Play from here');

  const icon = hoverPlayIcon();
  icon.style.width = '24px';
  icon.style.height = '24px';
  btn.appendChild(icon);

  shadow.appendChild(btn);

  let currentParagraphIndex = -1;
  let fadeOutTimer = null;

  function showAt(element, index) {
    // Cancel any pending fade-out
    if (fadeOutTimer !== null) {
      clearTimeout(fadeOutTimer);
      fadeOutTimer = null;
    }

    currentParagraphIndex = index;

    const rect = element.getBoundingClientRect();
    btn.style.left = `${rect.left - 36}px`;
    btn.style.top = `${rect.top}px`;

    // Reset animation by removing fade-out class and forcing reflow
    btn.classList.remove('fade-out');
    btn.style.display = 'flex';
    // Trigger reflow to restart the fadeIn animation defined in CSS on .hover-player
    void btn.offsetWidth;
  }

  function hide() {
    btn.classList.add('fade-out');
    // After the fadeOut animation completes (0.2s per CSS), actually hide
    fadeOutTimer = setTimeout(() => {
      btn.style.display = 'none';
      btn.classList.remove('fade-out');
      fadeOutTimer = null;
    }, 200);
  }

  function hideImmediate() {
    if (fadeOutTimer !== null) {
      clearTimeout(fadeOutTimer);
      fadeOutTimer = null;
    }
    btn.style.display = 'none';
    btn.classList.remove('fade-out');
  }

  // Attach mouseenter/mouseleave to each paragraph element
  paragraphs.forEach((para, index) => {
    const el = para.element;
    if (!el) return;

    el.addEventListener('mouseenter', () => {
      if (state.get().playback === 'idle') {
        showAt(el, index);
      }
    });

    el.addEventListener('mouseleave', (e) => {
      // Don't hide if moving into the hover button itself
      if (e.relatedTarget === btn || btn.contains(e.relatedTarget)) return;
      hide();
    });
  });

  // Keep hover button visible when mouse moves onto it from a paragraph
  btn.addEventListener('mouseleave', () => {
    hide();
  });

  // Click handler: play from the hovered paragraph
  btn.addEventListener('click', () => {
    if (currentParagraphIndex >= 0) {
      hideImmediate();
      actions.play(currentParagraphIndex);
    }
  });

  // On scroll: dismiss immediately
  window.addEventListener('scroll', () => {
    hideImmediate();
  }, { passive: true, capture: true });

  // State subscription: hide when playback leaves idle
  state.subscribe((current, prev) => {
    if (prev.playback === 'idle' && current.playback !== 'idle') {
      hideImmediate();
    }
  });
}
