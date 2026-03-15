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
  let hideDelayTimer = null;
  let isOverButton = false;

  function showAt(element, index) {
    if (fadeOutTimer !== null) { clearTimeout(fadeOutTimer); fadeOutTimer = null; }
    if (hideDelayTimer !== null) { clearTimeout(hideDelayTimer); hideDelayTimer = null; }

    currentParagraphIndex = index;

    const rect = element.getBoundingClientRect();
    btn.style.left = `${rect.left - 36}px`;
    btn.style.top = `${rect.top}px`;

    btn.classList.remove('fade-out');
    btn.style.display = 'flex';
    void btn.offsetWidth;
  }

  function hide() {
    btn.classList.add('fade-out');
    fadeOutTimer = setTimeout(() => {
      btn.style.display = 'none';
      btn.classList.remove('fade-out');
      fadeOutTimer = null;
    }, 200);
  }

  function hideImmediate() {
    if (fadeOutTimer !== null) { clearTimeout(fadeOutTimer); fadeOutTimer = null; }
    if (hideDelayTimer !== null) { clearTimeout(hideDelayTimer); hideDelayTimer = null; }
    btn.style.display = 'none';
    btn.classList.remove('fade-out');
  }

  // Use a short delay on paragraph mouseleave so the user can reach the button
  function scheduleHide() {
    if (hideDelayTimer !== null) clearTimeout(hideDelayTimer);
    hideDelayTimer = setTimeout(() => {
      hideDelayTimer = null;
      if (!isOverButton) hide();
    }, 150);
  }

  paragraphs.forEach((para, index) => {
    const el = para.element;
    if (!el) return;

    el.addEventListener('mouseenter', () => {
      if (hideDelayTimer !== null) { clearTimeout(hideDelayTimer); hideDelayTimer = null; }
      if (state.get().playback === 'idle') {
        showAt(el, index);
      }
    });

    el.addEventListener('mouseleave', () => {
      scheduleHide();
    });
  });

  btn.addEventListener('mouseenter', () => {
    isOverButton = true;
    if (hideDelayTimer !== null) { clearTimeout(hideDelayTimer); hideDelayTimer = null; }
    if (fadeOutTimer !== null) { clearTimeout(fadeOutTimer); fadeOutTimer = null; }
    btn.classList.remove('fade-out');
    btn.style.display = 'flex';
  });

  btn.addEventListener('mouseleave', () => {
    isOverButton = false;
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
