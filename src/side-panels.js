import { closeIcon, searchIcon } from './icons.js';
import { VOICES } from './voices.js';

// ============================================================
// HELPERS
// ============================================================

function avatarColor(name) {
  // Derive a consistent hue from the name string
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 42%)`;
}

function speedLabel(speed) {
  if (speed < 0.9) return 'Slow';
  if (speed <= 1.1) return 'Normal';
  return 'Fast';
}

function formatDurationFromSpeed(totalDurationSec) {
  const secs = Math.max(0, Math.round(totalDurationSec));
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  return `${mins}:${String(s).padStart(2, '0')}`;
}

function clampSpeed(v) {
  return Math.round(Math.min(4.5, Math.max(0.4, v)) * 10) / 10;
}

// ============================================================
// SPEED PANEL
// ============================================================

function createSpeedPanel(state, actions) {
  const panel = document.createElement('div');
  panel.className = 'side-panel speed-panel';

  // --- Header ---
  const header = document.createElement('div');
  header.className = 'side-panel-header';
  header.style.paddingBottom = '4px';

  const labelEl = document.createElement('span');
  labelEl.className = 'speed-label';
  labelEl.style.cssText = 'font-size: 13px; font-weight: 500; color: var(--text-secondary);';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'panel-close-btn';
  closeBtn.setAttribute('aria-label', 'Close');
  const closeIc = closeIcon();
  closeIc.style.width = '16px';
  closeIc.style.height = '16px';
  closeBtn.appendChild(closeIc);
  closeBtn.addEventListener('click', () => state.dispatch({ panelOpen: null }));

  header.appendChild(labelEl);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // --- Speed display + +/- controls ---
  const displayRow = document.createElement('div');
  displayRow.className = 'speed-display';

  const speedControls = document.createElement('div');
  speedControls.className = 'speed-controls';

  const decBtn = document.createElement('button');
  decBtn.className = 'btn';
  decBtn.style.cssText = 'width: 36px; height: 36px; border-radius: 50%; font-size: 20px; font-weight: 400; background: var(--bg-divider); color: var(--text-primary); display: inline-flex; align-items: center; justify-content: center; border: none; cursor: pointer;';
  decBtn.textContent = '−';
  decBtn.setAttribute('aria-label', 'Decrease speed');

  const speedValueEl = document.createElement('span');
  speedValueEl.className = 'speed-value';

  const incBtn = document.createElement('button');
  incBtn.className = 'btn';
  incBtn.style.cssText = 'width: 36px; height: 36px; border-radius: 50%; font-size: 20px; font-weight: 400; background: var(--bg-divider); color: var(--text-primary); display: inline-flex; align-items: center; justify-content: center; border: none; cursor: pointer;';
  incBtn.textContent = '+';
  incBtn.setAttribute('aria-label', 'Increase speed');

  decBtn.addEventListener('click', () => {
    const current = state.get().speed;
    actions.setSpeed(clampSpeed(current - 0.1));
  });

  incBtn.addEventListener('click', () => {
    const current = state.get().speed;
    actions.setSpeed(clampSpeed(current + 0.1));
  });

  speedControls.appendChild(decBtn);
  speedControls.appendChild(speedValueEl);
  speedControls.appendChild(incBtn);

  displayRow.appendChild(speedControls);
  panel.appendChild(displayRow);

  // --- Presets ---
  const presets = document.createElement('div');
  presets.className = 'speed-presets';

  const presetValues = [0.8, 1, 1.2, 1.5, 2];
  const presetBtns = presetValues.map(v => {
    const btn = document.createElement('button');
    btn.className = 'speed-preset-btn';
    btn.textContent = v === 1 ? '1x' : `${v}x`;
    btn.dataset.speed = v;
    btn.addEventListener('click', () => actions.setSpeed(v));
    presets.appendChild(btn);
    return btn;
  });

  panel.appendChild(presets);

  // --- Slider ---
  const sliderWrapper = document.createElement('div');
  sliderWrapper.style.cssText = 'width: 100%; padding: 0 4px; box-sizing: border-box;';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'speed-slider';
  slider.min = '0.4';
  slider.max = '4.5';
  slider.step = '0.1';
  slider.style.width = '100%';
  slider.addEventListener('input', () => {
    actions.setSpeed(parseFloat(slider.value));
  });

  sliderWrapper.appendChild(slider);
  panel.appendChild(sliderWrapper);

  // --- Duration estimate ---
  const durationEl = document.createElement('div');
  durationEl.style.cssText = 'font-size: 12px; color: var(--text-secondary); text-align: center; padding-bottom: 4px;';

  panel.appendChild(durationEl);

  // --- Sync function: update all UI from state ---
  function sync(s) {
    const spd = s.speed;
    labelEl.textContent = speedLabel(spd);
    speedValueEl.textContent = `${spd.toFixed(1)}x`;
    slider.value = String(spd);

    presetBtns.forEach(btn => {
      const v = parseFloat(btn.dataset.speed);
      btn.classList.toggle('active', Math.abs(v - spd) < 0.05);
    });

    const dur = formatDurationFromSpeed(s.totalDurationSec);
    durationEl.textContent = `Duration: ~${dur}`;
  }

  // Initial render
  sync(state.get());

  return { panel, sync };
}

// ============================================================
// VOICE PANEL
// ============================================================

function createVoicePanel(state) {
  const panel = document.createElement('div');
  panel.className = 'side-panel voice-panel';

  // --- Header ---
  const header = document.createElement('div');
  header.className = 'side-panel-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'panel-title';
  titleEl.textContent = 'Voices';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'panel-close-btn';
  closeBtn.setAttribute('aria-label', 'Close');
  const closeIc = closeIcon();
  closeIc.style.width = '16px';
  closeIc.style.height = '16px';
  closeBtn.appendChild(closeIc);
  closeBtn.addEventListener('click', () => state.dispatch({ panelOpen: null }));

  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // --- Search ---
  const searchWrapper = document.createElement('div');
  searchWrapper.className = 'voice-search';

  const searchIc = searchIcon();
  searchIc.style.width = '16px';
  searchIc.style.height = '16px';
  searchWrapper.appendChild(searchIc);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search voices...';
  searchWrapper.appendChild(searchInput);
  panel.appendChild(searchWrapper);

  // --- Voice list ---
  const listEl = document.createElement('div');
  listEl.className = 'voice-list';
  panel.appendChild(listEl);

  const allVoices = VOICES;

  function renderList(selectedVoiceId, query) {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

    const q = (query || '').toLowerCase();
    const filtered = q
      ? allVoices.filter(v => v.name.toLowerCase().includes(q))
      : allVoices;

    filtered.forEach(voice => {
      const item = document.createElement('div');
      item.className = 'voice-item';
      if (voice.id === selectedVoiceId) item.classList.add('selected');

      const avatar = document.createElement('div');
      avatar.className = 'voice-avatar';
      avatar.style.background = avatarColor(voice.name);
      avatar.style.position = 'relative';
      avatar.textContent = voice.name.charAt(0).toUpperCase();

      const cacheStatus = state.get().voiceCache[voice.id] || 'uncached';
      if (cacheStatus === 'uncached') {
        const dlIcon = document.createElement('div');
        dlIcon.className = 'voice-download-indicator';
        dlIcon.textContent = '↓';
        avatar.appendChild(dlIcon);
      } else if (cacheStatus === 'downloading') {
        avatar.classList.add('downloading');
      }

      const info = document.createElement('div');
      info.className = 'voice-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'voice-name';
      nameEl.textContent = voice.name;

      const langEl = document.createElement('div');
      langEl.className = 'voice-lang';
      langEl.textContent = voice.lang;

      info.appendChild(nameEl);
      info.appendChild(langEl);

      item.appendChild(avatar);
      item.appendChild(info);

      item.addEventListener('click', () => {
        state.dispatch({ voiceId: voice.id, panelOpen: null });
      });

      listEl.appendChild(item);
    });
  }

  // Initial render
  renderList(state.get().voiceId, '');

  // Search input handler
  searchInput.addEventListener('input', () => {
    renderList(state.get().voiceId, searchInput.value);
  });

  function sync(s) {
    renderList(s.voiceId, searchInput.value);
  }

  return { panel, sync, resetSearch: () => { searchInput.value = ''; } };
}

// ============================================================
// INIT
// ============================================================

export function initSidePanels(shadow, state, actions) {
  const pill = shadow.querySelector('.pill-container');
  if (!pill) {
    console.error('[Pocket Speechify] pill-container not found — side panels cannot attach');
    return;
  }

  // Make sure pill-container doesn't clip the panels that extend outside it
  pill.style.overflow = 'visible';

  const { panel: speedPanel, sync: syncSpeed } = createSpeedPanel(state, actions);
  const { panel: voicePanel, sync: syncVoice, resetSearch } = createVoicePanel(state);

  // Panels start hidden
  speedPanel.style.display = 'none';
  voicePanel.style.display = 'none';

  pill.appendChild(speedPanel);
  pill.appendChild(voicePanel);

  state.subscribe((current, prev) => {
    if (current.panelOpen !== prev.panelOpen) {
      if (current.panelOpen === 'speed') {
        voicePanel.style.display = 'none';
        syncSpeed(current);
        speedPanel.style.display = '';
        // Re-trigger animation
        speedPanel.style.animation = 'none';
        speedPanel.offsetHeight; // reflow
        speedPanel.style.animation = '';
      } else if (current.panelOpen === 'voice') {
        speedPanel.style.display = 'none';
        resetSearch();
        syncVoice(current);
        voicePanel.style.display = '';
        voicePanel.style.animation = 'none';
        voicePanel.offsetHeight; // reflow
        voicePanel.style.animation = '';
      } else {
        speedPanel.style.display = 'none';
        voicePanel.style.display = 'none';
      }
    }

    // Keep speed panel in sync while it's open
    if (current.panelOpen === 'speed' &&
        (current.speed !== prev.speed || current.totalDurationSec !== prev.totalDurationSec)) {
      syncSpeed(current);
    }

    // Keep voice panel in sync while it's open
    if (current.panelOpen === 'voice' &&
        (current.voiceId !== prev.voiceId || current.voiceCache !== prev.voiceCache)) {
      syncVoice(current);
    }
  });
}
