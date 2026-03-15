import { waveformIcon, playIcon, pauseIcon, circularProgress, skipBackIcon, skipForwardIcon, bookmarkIcon, reportIcon, libraryIcon, settingsIcon, upgradeIcon, turnOffIcon } from './icons.js';

function formatDuration(totalSec, elapsedSec) {
  const remaining = Math.max(0, Math.ceil(totalSec - elapsedSec));
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return { mins: String(mins), secs: String(secs).padStart(2, '0') };
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
      console.log('[PS pill] idle play button clicked');
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
  // Placeholder avatar: 26px circle with accent-blue background and "S" text
  const voiceCircle = document.createElement('span');
  voiceCircle.style.cssText = 'width: 26px; height: 26px; border-radius: 50%; background: var(--accent-blue); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #fff; pointer-events: none;';
  voiceCircle.textContent = 'S';
  voiceBtn.appendChild(voiceCircle);
  voiceBtn.addEventListener('click', (e) => {
    e.stopPropagation();
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

  // Save to Library button (32x32)
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-32 btn-standard';
  saveBtn.setAttribute('aria-label', 'Save to Library');
  const saveIc = bookmarkIcon();
  saveIc.style.width = '20px';
  saveIc.style.height = '20px';
  saveBtn.appendChild(saveIc);
  pillBottom.appendChild(saveBtn);

  // Report a Problem button (32x32)
  const reportBtn = document.createElement('button');
  reportBtn.className = 'btn btn-32 btn-standard';
  reportBtn.setAttribute('aria-label', 'Report a Problem');
  const reportIc = reportIcon();
  reportIc.style.width = '20px';
  reportIc.style.height = '20px';
  reportBtn.appendChild(reportIc);
  pillBottom.appendChild(reportBtn);

  // View Library button (32x32)
  const libraryBtn = document.createElement('button');
  libraryBtn.className = 'btn btn-32 btn-standard';
  libraryBtn.setAttribute('aria-label', 'View Library');
  const libraryIc = libraryIcon();
  libraryIc.style.width = '20px';
  libraryIc.style.height = '20px';
  libraryBtn.appendChild(libraryIc);
  pillBottom.appendChild(libraryBtn);

  // Settings button (32x32)
  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'btn btn-32 btn-standard';
  settingsBtn.setAttribute('aria-label', 'Settings');
  const settingsIc = settingsIcon();
  settingsIc.style.width = '20px';
  settingsIc.style.height = '20px';
  settingsBtn.appendChild(settingsIc);
  pillBottom.appendChild(settingsBtn);

  // Upgrade to Premium button (32x32)
  const upgradeBtn = document.createElement('button');
  upgradeBtn.className = 'btn btn-32 btn-standard';
  upgradeBtn.setAttribute('aria-label', 'Upgrade to Premium');
  const upgradeIc = upgradeIcon();
  upgradeIc.style.width = '20px';
  upgradeIc.style.height = '20px';
  upgradeBtn.appendChild(upgradeIc);
  pillBottom.appendChild(upgradeBtn);

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

    // Update speed text
    if (current.speed !== prev.speed) {
      speedText.textContent = `${current.speed}x`;
    }

    const percent = current.totalDurationSec > 0
      ? (current.elapsedSec / current.totalDurationSec) * 100
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
      (current.elapsedSec !== prev.elapsedSec || current.totalDurationSec !== prev.totalDurationSec)
    ) {
      // Progress changed — swap just the circular progress SVG
      const ring = toggleSlot.querySelector('.progress-ring');
      if (ring) {
        const oldSvg = ring.querySelector('svg');
        if (oldSvg) {
          const newSvg = circularProgress(percent);
          newSvg.style.cssText = 'width: 100%; height: 100%;';
          ring.replaceChild(newSvg, oldSvg);
        }
      }
    }
  });

  // --- Append to shadow root ---
  shadow.appendChild(pill);
}
