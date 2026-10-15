import { loadTextRules } from '../src/text-rules.js';
import { createSpeechProfileStore, normalizeVolumeSettings, VOLUME_SETTINGS_KEY } from '../src/speech-preferences.js';

export default defineBackground(() => {
  const profiles = createSpeechProfileStore(chrome.storage.local);
  let volumeSettingsQueue = Promise.resolve();
  let offscreenCreating = null;
  // Preserve command order even when offscreen discovery/creation is asynchronous.
  let forwarding = Promise.resolve();

  async function hasOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    return existingContexts.length > 0;
  }

  async function ensureOffscreenDocument() {
    if (await hasOffscreenDocument()) return;

    if (offscreenCreating) {
      await offscreenCreating;
      return;
    }

    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK', 'WORKERS'],
      justification: 'TTS audio playback, WASM inference, and model download',
    });
    try {
      await offscreenCreating;
    } finally {
      // Reset on failure too, so the next request retries creation.
      offscreenCreating = null;
    }
  }

  const lastLoggedBucket = new Map();
  // Last known top-frame URL per tab. A fragment-only change keeps the document
  // and its playback: Google Docs rewrites #heading=… as the cursor moves, and
  // Chrome reports that as a loading tab. Change URLs are only visible where
  // the extension has host access (Google Docs).
  const tabUrls = new Map();
  const withoutFragment = url => url.split('#')[0];

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    // --- Messages FROM content scripts (have sender.tab) ---
    if (sender.tab) {
      if (msg.type === 'volume-settings-get' || msg.type === 'volume-settings-update') {
        const result = volumeSettingsQueue.then(async () => {
          if (msg.type === 'volume-settings-get') {
            const saved = await chrome.storage.local.get(VOLUME_SETTINGS_KEY);
            return normalizeVolumeSettings(saved[VOLUME_SETTINGS_KEY]);
          }
          const settings = normalizeVolumeSettings(msg.settings);
          await chrome.storage.local.set({ [VOLUME_SETTINGS_KEY]: settings });
          return settings;
        });
        volumeSettingsQueue = result.catch(() => {});
        result.then(sendResponse, error => {
          console.warn('[Pocket Speechify] Volume settings request failed:', error);
          sendResponse({ error: String(error) });
        });
        return true;
      }
      if (['speech-detect-language', 'speech-profile-get', 'speech-profile-update'].includes(msg.type)) {
        // Detection and preferences never create or block the audio pipeline.
        const result = Promise.resolve().then(() => {
          if (msg.type === 'speech-detect-language') return chrome.i18n.detectLanguage(String(msg.text || '').slice(0, 12000));
          return msg.type === 'speech-profile-get'
            ? profiles.get(msg.language) : profiles.update(msg.language, msg.patch || {});
        });
        result.then(sendResponse, error => {
          console.warn('[Pocket Speechify] Speech settings request failed:', error);
          sendResponse({ error: String(error) });
        });
        return true;
      }
      console.log('[SW] From content script:', msg.type, msg);
      if (sender.frameId === 0 && sender.url) tabUrls.set(sender.tab.id, sender.url);
      // TTS control messages: forward to offscreen document
      if (msg.type.startsWith('tts-')) {
        forwarding = forwarding.then(() => handleTTSFromContent(msg, sender.tab.id));
      }
      return;
    }

    // --- Messages FROM offscreen document (source: 'offscreen') ---
    if (msg.source === 'offscreen') {
      if (msg.type === 'diag') {
        console.log('[DIAG]', msg.message);
        return;
      }
      if (msg.type === 'download-progress') {
        const key = `${msg.language || ''}:${msg.asset}:${msg.voiceId || ''}`;
        const bucket = Math.floor(msg.percent / 5) * 5;
        if (!lastLoggedBucket.has(key) || lastLoggedBucket.get(key) < bucket) {
          lastLoggedBucket.set(key, bucket);
          const languageLabel = msg.language ? `${msg.language}:` : '';
          console.log(`[SW] Download ${languageLabel}${msg.asset}${msg.voiceId ? ':' + msg.voiceId : ''}: ${msg.percent}%`);
        }
      } else {
        console.log('[SW] From offscreen:', msg.type, msg);
      }
      // Forward events only to the tab that initiated playback
      if (msg.type === 'download-progress' || msg.type === 'download-complete' ||
          msg.type === 'tts-word' || msg.type === 'tts-sentence-event' ||
          msg.type === 'tts-processed-text' ||
          msg.type === 'tts-paragraph-done' || msg.type === 'tts-superseded') {
        sendToOwner(msg);
      }
      return;
    }

    // Ignore messages from self or other extension contexts
  });

  async function handleTTSFromContent(msg, tabId) {
    try {
      const payload = { ...msg, source: 'service-worker', tabId };
      if (msg.type === 'tts-play-paragraph') {
        // Offscreen documents only expose runtime. Read fresh rules here so
        // settings changes also reach paragraphs from already-open tabs.
        payload.textRules = await loadTextRules(chrome.storage.local);
        // A tab that closed while its play was in flight must not start audio.
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          console.log('[SW] Dropping play for missing tab', tabId);
          return;
        }
      }
      console.log('[SW] Ensuring offscreen document...');
      await ensureOffscreenDocument();
      console.log('[SW] Offscreen ready. Forwarding:', msg.type);
      // Forward to offscreen doc with source tag + tab ID so it knows origin
      await chrome.runtime.sendMessage(payload);
      console.log('[SW] Message forwarded to offscreen');
    } catch (err) {
      console.error('[SW] handleTTSFromContent error:', err);
      if (msg.type === 'tts-play-paragraph') {
        chrome.tabs.sendMessage(tabId, {
          type: 'tts-paragraph-done', sessionId: msg.sessionId, genId: msg.genId, error: String(err), fatal: true,
        }).catch(() => {});
      }
    }
  }

  // Stop orphan audio when the tab that owns playback disappears. Queued on the
  // same chain as play/pause, so a close racing a play cannot start after cancel.
  function cancelTabPlayback(tabId) {
    forwarding = forwarding
      .then(async () => {
        if (!(await hasOffscreenDocument())) return;
        console.log('[SW] Cancelling playback for tab', tabId);
        await chrome.runtime.sendMessage({ type: 'tts-cancel-tab', tabId, source: 'service-worker' });
      })
      .catch(err => console.warn('[SW] Tab playback cancel failed:', err));
  }

  function sendToOwner(msg) {
    if (msg.tabId == null) return;
    const { source, ...payload } = msg;
    chrome.tabs.sendMessage(msg.tabId, payload).catch(() => {});
  }

  // Tab close, reload, navigation, or discard: unload messaging from the
  // content script is unreliable, so the service worker owns this signal.
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabUrls.delete(tabId);
    console.log('[SW] Tab removed:', tabId);
    cancelTabPlayback(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const previousUrl = tabUrls.get(tabId);
    if (changeInfo.url) tabUrls.set(tabId, changeInfo.url);
    if (changeInfo.status !== 'loading' && !changeInfo.discarded) return;
    // Reloads report no URL; same-document fragment updates report the URL,
    // possibly unchanged when Docs re-sets the same #heading.
    if (!changeInfo.discarded && changeInfo.url && previousUrl &&
        withoutFragment(changeInfo.url) === withoutFragment(previousUrl)) {
      console.log('[SW] Tab fragment changed, keeping playback:', tabId);
      return;
    }
    console.log('[SW] Tab navigating or discarded:', tabId);
    cancelTabPlayback(tabId);
  });

  // Toolbar button click: toggle pill player visibility on the active tab
  chrome.action.onClicked.addListener((tab) => {
    console.log('[SW] Toolbar button clicked, toggling pill on tab', tab.id);
    chrome.tabs.sendMessage(tab.id, { type: 'toggle-pill' }).catch(() => {});
  });
});
