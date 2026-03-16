import { waveformIcon, playIcon, pauseIcon, circularProgress, skipBackIcon, skipForwardIcon, bookmarkIcon, trashIcon, closeIcon, settingsIcon, turnOffIcon } from './icons.js';
import { getVoiceAvatarUrl } from './voices.js';

function formatDuration(totalSec, elapsedSec) {
  const remaining = Math.max(0, Math.ceil(totalSec - elapsedSec));
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return { mins: String(mins), secs: String(secs).padStart(2, '0') };
}

// Build download progress button (circular ring with percentage text inside)
function renderDownloadButton(percent) {
  const ring = document.createElement('div');
  ring.className = 'progress-ring';

  const progressSvg = circularProgress(percent);
  progressSvg.style.cssText = 'width: 100%; height: 100%;';
  ring.appendChild(progressSvg);

  const btn = document.createElement('button');
  btn.className = 'btn btn-32 btn-cta';
  btn.style.pointerEvents = 'none';
  btn.setAttribute('aria-label', `Downloading: ${percent}%`);
  const pctText = document.createElement('span');
  pctText.style.cssText = 'font-size: 9px; font-weight: 700; pointer-events: none;';
  pctText.textContent = `${percent}%`;
  btn.appendChild(pctText);
  ring.appendChild(btn);
  return ring;
}

// Build idle play button
function renderIdlePlayButton(hasContent, actions) {
  const btn = document.createElement('button');
  btn.className = 'btn btn-32 btn-cta';
  if (!hasContent) btn.classList.add('btn-disabled');
  btn.setAttribute('aria-label', 'Play');
  const ic = playIcon();
  ic.style.width = '14px';
  ic.style.height = '14px';
  btn.appendChild(ic);
  if (hasContent) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      actions.play();
    });
  }
  return btn;
}

// Build the progress ring + toggle button (no skip buttons — those are persistent)
function renderToggleButton(playbackState, percent, actions) {
  const ring = document.createElement('div');
  ring.className = 'progress-ring';

  const progressSvg = circularProgress(percent);
  progressSvg.style.cssText = 'width: 100%; height: 100%;';
  ring.appendChild(progressSvg);

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn btn-32 btn-cta';

  if (playbackState === 'playing') {
    toggleBtn.setAttribute('aria-label', 'Pause');
    const ic = pauseIcon();
    ic.style.width = '10px';
    ic.style.height = '12px';
    toggleBtn.appendChild(ic);
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      actions.pause();
    });
  } else {
    toggleBtn.setAttribute('aria-label', 'Resume');
    const ic = playIcon();
    ic.style.width = '14px';
    ic.style.height = '14px';
    toggleBtn.appendChild(ic);
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      actions.resume();
    });
  }

  ring.appendChild(toggleBtn);
  return ring;
}

// Build skip buttons row (created once, reused)
function createSkipButtons(actions) {
  const skipRow = document.createElement('div');
  skipRow.className = 'skip-buttons';

  const skipBackBtn = document.createElement('button');
  skipBackBtn.className = 'btn btn-16';
  skipBackBtn.setAttribute('aria-label', 'Skip back');
  skipBackBtn.style.cssText = 'background: transparent; padding: 0;';
  const sbIcon = skipBackIcon();
  sbIcon.style.cssText = 'width: 16px; height: 16px;';
  skipBackBtn.appendChild(sbIcon);
  skipBackBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    actions.skipBack();
  });

  const skipFwdBtn = document.createElement('button');
  skipFwdBtn.className = 'btn btn-16';
  skipFwdBtn.setAttribute('aria-label', 'Skip forward');
  skipFwdBtn.style.cssText = 'background: transparent; padding: 0;';
  const sfIcon = skipForwardIcon();
  sfIcon.style.cssText = 'width: 16px; height: 16px;';
  skipFwdBtn.appendChild(sfIcon);
  skipFwdBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    actions.skipForward();
  });

  skipRow.appendChild(skipBackBtn);
  skipRow.appendChild(skipFwdBtn);
  return skipRow;
}

export function initPillPlayer(shadow, state, actions, paragraphs) {
  const hasContent = paragraphs.length > 0;

  // --- Pill container ---
  const pill = document.createElement('div');
  pill.className = 'pill-container';

  // --- Pill main section ---
  const pillMain = document.createElement('div');
  pillMain.className = 'pill-main';

  // 1. Summarize button (48x48)
  const summarizeBtn = document.createElement('button');
  summarizeBtn.className = 'btn btn-48 btn-standard';
  summarizeBtn.setAttribute('aria-label', 'Summarize');
  const waveIcon = waveformIcon();
  waveIcon.style.width = '20px';
  waveIcon.style.height = '20px';
  summarizeBtn.appendChild(waveIcon);
  pillMain.appendChild(summarizeBtn);

  // 2. Duration display (MM:SS)
  const durationEl = document.createElement('div');
  durationEl.className = 'duration';
  const minsSpan = document.createElement('span');
  minsSpan.className = 'duration-mins';
  const sepSpan = document.createElement('span');
  sepSpan.className = 'duration-separator';
  sepSpan.textContent = ':';
  const secsSpan = document.createElement('span');
  secsSpan.className = 'duration-secs';

  durationEl.appendChild(minsSpan);
  durationEl.appendChild(sepSpan);
  durationEl.appendChild(secsSpan);
  pillMain.appendChild(durationEl);

  // Set initial duration
  const initState = state.get();
  const initDur = formatDuration(initState.totalDurationSec, initState.elapsedSec);
  minsSpan.textContent = initDur.mins;
  secsSpan.textContent = initDur.secs;

  // 3. Play area — toggle button swaps; skip buttons are persistent
  const playArea = document.createElement('div');
  playArea.className = 'play-area';
  playArea.style.cssText = 'display: flex; flex-direction: column; align-items: center; gap: 4px;';

  // toggleSlot holds either idle play button or progress-ring+toggle
  const toggleSlot = document.createElement('div');
  toggleSlot.appendChild(renderIdlePlayButton(hasContent, actions));
  playArea.appendChild(toggleSlot);

  // Skip buttons — created once, hidden in idle, shown during playing/paused
  const skipButtons = createSkipButtons(actions);
  skipButtons.style.display = 'none';
  playArea.appendChild(skipButtons);

  pillMain.appendChild(playArea);

  // 4. Divider (28x2)
  const divider = document.createElement('div');
  divider.className = 'divider';
  pillMain.appendChild(divider);

  // 5. Voice selector (32x32)
  const voiceBtn = document.createElement('button');
  voiceBtn.className = 'btn btn-32 btn-standard';
  voiceBtn.setAttribute('aria-label', 'Voice');
  const voiceImg = document.createElement('img');
  voiceImg.style.cssText = 'width: 26px; height: 26px; border-radius: 50%; object-fit: cover; pointer-events: none;';
  voiceImg.src = getVoiceAvatarUrl(initState.voiceId);
  voiceBtn.appendChild(voiceImg);
  voiceBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    console.log('[Pocket Speechify] Voice button clicked');
    state.dispatch({ panelOpen: state.get().panelOpen === 'voice' ? null : 'voice' });
  });
  pillMain.appendChild(voiceBtn);

  // 6. Speed control (32x32)
  const speedBtn = document.createElement('button');
  speedBtn.className = 'btn btn-32 btn-standard';
  speedBtn.setAttribute('aria-label', 'Speed');
  const speedText = document.createElement('span');
  speedText.style.cssText = 'font-size: 11px; font-weight: 700; pointer-events: none;';
  speedText.textContent = `${initState.speed}x`;
  speedBtn.appendChild(speedText);
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.dispatch({ panelOpen: state.get().panelOpen === 'speed' ? null : 'speed' });
  });
  pillMain.appendChild(speedBtn);

  pill.appendChild(pillMain);

  // --- Pill bottom section (visible on hover) ---
  const pillBottom = document.createElement('div');
  pillBottom.className = 'pill-bottom';
  pillBottom.style.marginTop = '8px';

  // Clear Cache button (32x32)
  const clearCacheBtn = document.createElement('button');
  clearCacheBtn.className = 'btn btn-32 btn-standard';
  clearCacheBtn.setAttribute('aria-label', 'Clear TTS Cache');
  const trashIc = trashIcon();
  trashIc.style.width = '20px';
  trashIc.style.height = '20px';
  clearCacheBtn.appendChild(trashIc);
  clearCacheBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    console.log('[Pocket Speechify] Clear Cache button clicked');
    // Cache lives in the extension origin (offscreen doc), not the page origin.
    // Route through the service worker → offscreen document.
    chrome.runtime.sendMessage({ type: 'tts-clear-cache', source: 'content' });
    state.dispatch({
      modelCached: false,
      voiceCache: state.buildEmptyVoiceCache(),
      downloadProgress: null,
    });
    // Flash the button to confirm
    clearCacheBtn.style.background = 'var(--bg-cta)';
    setTimeout(() => { clearCacheBtn.style.background = ''; }, 500);
  });
  pillBottom.appendChild(clearCacheBtn);

  // About button (32x32)
  const aboutBtn = document.createElement('button');
  aboutBtn.className = 'btn btn-32 btn-standard';
  aboutBtn.setAttribute('aria-label', 'About');
  const aboutIc = document.createElement('span');
  aboutIc.style.cssText = 'font-size: 16px; font-weight: 700; line-height: 1; pointer-events: none;';
  aboutIc.textContent = '?';
  aboutBtn.appendChild(aboutIc);
  aboutBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    console.log('[Pocket Speechify] About button clicked');
    // Read version from manifest
    const manifest = chrome.runtime.getManifest();
    const version = manifest.version_name || manifest.version;
    const name = manifest.name;

    // Toggle about panel
    let aboutPanel = shadow.querySelector('.about-panel');
    if (aboutPanel) {
      aboutPanel.remove();
      return;
    }
    aboutPanel = document.createElement('div');
    aboutPanel.className = 'about-panel';
    aboutPanel.style.cssText = [
      'position: absolute',
      'right: 60px',
      'bottom: 0',
      'background: var(--bg-primary)',
      'border-radius: 12px',
      'padding: 16px 20px',
      'box-shadow: var(--panel-shadow), 0px 4px 6px 0px rgba(0,0,0,0.32)',
      'color: var(--text-primary)',
      'font-family: system-ui, sans-serif',
      'font-size: 13px',
      'white-space: nowrap',
      'z-index: 10',
      'animation: panelSlideIn 0.15s ease-out',
    ].join('; ');
    aboutPanel.innerHTML = `
      <div style="font-weight: 700; font-size: 15px; margin-bottom: 4px;">${name}</div>
      <div style="color: var(--text-secondary);">Version ${version}</div>
      <div style="color: var(--text-tertiary); font-size: 11px; margin-top: 8px;">pocket-tts WASM &middot; 24kHz</div>
    `;
    aboutPanel.addEventListener('click', (ev) => { ev.stopPropagation(); aboutPanel.remove(); });
    pill.appendChild(aboutPanel);
  });
  // Settings button (32x32)
  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'btn btn-32 btn-standard';
  settingsBtn.setAttribute('aria-label', 'Settings');
  const settingsIc = settingsIcon();
  settingsIc.style.width = '20px';
  settingsIc.style.height = '20px';
  settingsBtn.appendChild(settingsIc);
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    console.log('[Pocket Speechify] Settings button clicked');
    let settingsPanel = shadow.querySelector('.settings-panel');
    if (settingsPanel) {
      settingsPanel.remove();
      return;
    }
    settingsPanel = document.createElement('div');
    settingsPanel.className = 'settings-panel';
    settingsPanel.style.cssText = [
      'position: absolute',
      'right: 60px',
      'bottom: 0',
      'width: 260px',
      'background: var(--bg-primary)',
      'border-radius: 12px',
      'padding: 16px',
      'box-shadow: var(--panel-shadow), 0px 4px 6px 0px rgba(0,0,0,0.32)',
      'color: var(--text-primary)',
      'font-family: system-ui, sans-serif',
      'font-size: 13px',
      'z-index: 10',
      'animation: fadeIn 0.1s ease-out both',
      'box-sizing: border-box',
    ].join('; ');

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;';
    const title = document.createElement('span');
    title.style.cssText = 'font-weight: 700; font-size: 15px;';
    title.textContent = 'Settings';
    const closePanelBtn = document.createElement('button');
    closePanelBtn.style.cssText = [
      'width: 20px', 'height: 20px', 'display: flex', 'align-items: center',
      'justify-content: center', 'border: none', 'background: transparent',
      'color: var(--text-primary)', 'cursor: pointer', 'border-radius: 50%',
      'padding: 0', 'opacity: 1', 'transition: opacity 0.1s ease', 'flex-shrink: 0',
    ].join('; ');
    closePanelBtn.addEventListener('mouseenter', () => { closePanelBtn.style.opacity = '0.75'; });
    closePanelBtn.addEventListener('mouseleave', () => { closePanelBtn.style.opacity = '1'; });
    const closeIc = closeIcon();
    closeIc.style.cssText = 'width: 12px; height: 12px;';
    closePanelBtn.appendChild(closeIc);
    closePanelBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      console.log('[Pocket Speechify] Settings panel close clicked');
      settingsPanel.remove();
    });
    header.appendChild(title);
    header.appendChild(closePanelBtn);
    settingsPanel.appendChild(header);

    // Divider
    const divEl = document.createElement('div');
    divEl.style.cssText = 'height: 1px; background: var(--bg-divider); margin-bottom: 16px;';
    settingsPanel.appendChild(divEl);

    // Empty content area (placeholder for future settings)
    const content = document.createElement('div');
    content.style.cssText = 'height: 32px;';
    settingsPanel.appendChild(content);

    // Footer with Save button
    const footer = document.createElement('div');
    footer.style.cssText = 'padding-top: 12px; border-top: 1px solid var(--bg-divider);';
    const saveBtn = document.createElement('button');
    saveBtn.style.cssText = [
      'width: 100%', 'height: 36px', 'border-radius: 8px', 'border: none',
      'background: var(--bg-cta)', 'color: var(--text-primary)',
      'font-family: system-ui, sans-serif', 'font-size: 14px',
      'font-weight: 600', 'cursor: pointer', 'transition: background 0.1s ease',
    ].join('; ');
    saveBtn.textContent = 'Save Settings';
    saveBtn.addEventListener('mouseenter', () => { saveBtn.style.background = 'var(--bg-cta-hover)'; });
    saveBtn.addEventListener('mouseleave', () => { saveBtn.style.background = 'var(--bg-cta)'; });
    saveBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      console.log('[Pocket Speechify] Save Settings clicked');
      settingsPanel.remove();
    });
    footer.appendChild(saveBtn);
    settingsPanel.appendChild(footer);

    settingsPanel.addEventListener('click', (ev) => ev.stopPropagation());
    pill.appendChild(settingsPanel);
  });
  pillBottom.appendChild(settingsBtn);
  pillBottom.appendChild(aboutBtn);

  // Turn Off button (20x20)
  const turnOffBtn = document.createElement('button');
  turnOffBtn.className = 'btn btn-20 btn-turnoff';
  turnOffBtn.setAttribute('aria-label', 'Turn Off');
  const turnOffIc = turnOffIcon();
  turnOffIc.style.width = '12px';
  turnOffIc.style.height = '12px';
  turnOffBtn.appendChild(turnOffIc);
  turnOffBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    actions.stop();
    const container = shadow.querySelector('.pill-container');
    if (container) container.style.display = 'none';
  });
  pillBottom.appendChild(turnOffBtn);

  pill.appendChild(pillBottom);

  // --- Hover events on pill container ---
  pill.addEventListener('mouseenter', () => {
    pill.classList.add('expanded');
    state.dispatch({ pillExpanded: true });
  });

  pill.addEventListener('mouseleave', () => {
    pill.classList.remove('expanded');
    state.dispatch({ pillExpanded: false });
  });

  // --- Subscribe to state changes ---
  state.subscribe((current, prev) => {
    // Update duration display
    if (current.totalDurationSec !== prev.totalDurationSec || current.elapsedSec !== prev.elapsedSec) {
      const dur = formatDuration(current.totalDurationSec, current.elapsedSec);
      minsSpan.textContent = dur.mins;
      secsSpan.textContent = dur.secs;
    }

    // Update voice avatar when voice changes
    if (current.voiceId !== prev.voiceId) {
      voiceImg.src = getVoiceAvatarUrl(current.voiceId);
    }

    // Show download progress as circular ring around play button
    if (current.downloadProgress !== prev.downloadProgress) {
      while (toggleSlot.firstChild) toggleSlot.removeChild(toggleSlot.firstChild);
      if (current.downloadProgress && current.downloadProgress.percent >= 0) {
        toggleSlot.appendChild(renderDownloadButton(current.downloadProgress.percent));
        skipButtons.style.display = 'none';
      } else if (!current.downloadProgress) {
        // Download done — restore correct play state
        if (current.playback === 'idle') {
          toggleSlot.appendChild(renderIdlePlayButton(hasContent, actions));
          skipButtons.style.display = 'none';
        } else {
          const pct = current.totalDurationSec > 0
            ? (current.elapsedSec / current.totalDurationSec) * 100 : 0;
          toggleSlot.appendChild(renderToggleButton(current.playback, pct, actions));
          skipButtons.style.display = '';
        }
      }
    }

    // Update speed text
    if (current.speed !== prev.speed) {
      speedText.textContent = `${current.speed}x`;
    }

    const effectiveElapsed = (current.elapsedOffsetSec || 0) + current.elapsedSec;
    const percent = current.totalDurationSec > 0
      ? Math.min(100, (effectiveElapsed / current.totalDurationSec) * 100)
      : 0;

    if (current.playback !== prev.playback) {
      // Playback state changed — rebuild only the toggle slot
      while (toggleSlot.firstChild) toggleSlot.removeChild(toggleSlot.firstChild);
      if (current.playback === 'idle') {
        toggleSlot.appendChild(renderIdlePlayButton(hasContent, actions));
        skipButtons.style.display = 'none';
      } else {
        toggleSlot.appendChild(renderToggleButton(current.playback, percent, actions));
        skipButtons.style.display = '';
      }
    } else if (
      (current.playback === 'playing' || current.playback === 'paused') &&
      (current.elapsedSec !== prev.elapsedSec || current.totalDurationSec !== prev.totalDurationSec || current.elapsedOffsetSec !== prev.elapsedOffsetSec)
    ) {
      // Progress changed — update only the arc's stroke-dashoffset, no new elements
      const ring = toggleSlot.querySelector('.progress-ring');
      if (ring) {
        const arc = ring.querySelector('svg path:last-of-type');
        if (arc) {
          const circumference = 2 * Math.PI * 46;
          const offset = circumference - (percent / 100) * circumference;
          arc.setAttribute('stroke-dashoffset', `${offset}`);
        }
      }
    }
  });

  // --- Append to shadow root ---
  shadow.appendChild(pill);
}
