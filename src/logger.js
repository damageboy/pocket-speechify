/**
 * Lightweight logger with configurable levels.
 *
 * Log level is stored in localStorage under 'ps-log-level'.
 * Set from the browser console:
 *   __psSetLogLevel('debug')   — show everything
 *   __psSetLogLevel('info')    — info, warn, error
 *   __psSetLogLevel('warn')    — warn, error only
 *   __psSetLogLevel('error')   — errors only
 *   __psSetLogLevel('off')     — silent (default)
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, off: 4 };
const STORAGE_KEY = 'ps-log-level';

function getLevel() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored in LEVELS) return stored;
  } catch (_) { /* localStorage may be blocked */ }
  return 'off';
}

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[getLevel()];
}

const PREFIX = '[PocketSpeechify]';

export const log = {
  debug(...args) { if (shouldLog('debug')) console.debug(PREFIX, ...args); },
  info(...args)  { if (shouldLog('info'))  console.info(PREFIX, ...args); },
  warn(...args)  { if (shouldLog('warn'))  console.warn(PREFIX, ...args); },
  error(...args) { if (shouldLog('error')) console.error(PREFIX, ...args); },
};

// Expose level setter on window for easy console access
if (typeof window !== 'undefined') {
  window.__psSetLogLevel = (level) => {
    if (!(level in LEVELS)) {
      console.log(`Valid levels: ${Object.keys(LEVELS).join(', ')}`);
      return;
    }
    try { localStorage.setItem(STORAGE_KEY, level); } catch (_) {}
    console.log(`${PREFIX} Log level set to '${level}'`);
  };

  window.__psGetLogLevel = () => {
    const level = getLevel();
    console.log(`${PREFIX} Current log level: '${level}'`);
    return level;
  };
}
