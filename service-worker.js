// service-worker.js

let offscreenCreating = null;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existingContexts.length > 0) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK', 'WORKERS'],
    justification: 'TTS audio playback, WASM inference, and model download',
  });
  await offscreenCreating;
  offscreenCreating = null;
}

// Track active downloads for cross-tab coordination
// Key: cacheKey (e.g. "pocket-tts-v1/model/tts_b6369a24.safetensors")
// Value: { tabIds: Set<number> } — tabs waiting for this download
const activeDownloads = new Map();
const lastLoggedBucket = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // --- Messages FROM content scripts (have sender.tab) ---
  if (sender.tab) {
    console.log('[SW] From content script:', msg.type, msg);
    // TTS control messages: forward to offscreen document
    if (msg.type.startsWith('tts-')) {
      handleTTSFromContent(msg, sender.tab.id);
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
      const key = `${msg.asset}:${msg.voiceId || ''}`;
      const bucket = Math.floor(msg.percent / 5) * 5;
      if (!lastLoggedBucket.has(key) || lastLoggedBucket.get(key) < bucket) {
        lastLoggedBucket.set(key, bucket);
        console.log(`[SW] Download ${msg.asset}${msg.voiceId ? ':' + msg.voiceId : ''}: ${msg.percent}%`);
      }
    } else if (msg.type === 'tts-elapsed') {
      // High-frequency — only log at debug level
      console.debug('[SW] From offscreen:', msg.type);
    } else {
      console.log('[SW] From offscreen:', msg.type, msg);
    }
    // Events to broadcast to content scripts
    if (msg.type === 'download-progress' || msg.type === 'download-complete' ||
        msg.type === 'tts-word' || msg.type === 'tts-sentence-event' ||
        msg.type === 'tts-paragraph-done' || msg.type === 'tts-elapsed') {
      broadcastToContentScripts(msg);
    }
    return;
  }

  // --- Debug: relay service worker logs to content script ---
  if (msg.type === 'get-sw-status') {
    sendResponse({ status: 'alive', offscreenCreating: !!offscreenCreating, activeDownloads: activeDownloads.size });
    return;
  }

  // Ignore messages from self or other extension contexts
});

async function handleTTSFromContent(msg, tabId) {
  try {
    // Cross-tab download coordination: if a download is already in progress
    // for the same asset, don't start another one
    if (msg.type === 'tts-play-paragraph') {
      const downloadKey = `download-${msg.voiceId || 'model'}`;
      if (activeDownloads.has(downloadKey)) {
        activeDownloads.get(downloadKey).tabIds.add(tabId);
      } else {
        activeDownloads.set(downloadKey, { tabIds: new Set([tabId]) });
      }
    }

    console.log('[SW] Ensuring offscreen document...');
    await ensureOffscreenDocument();
    console.log('[SW] Offscreen ready. Forwarding:', msg.type);
    // Forward to offscreen doc with source tag + tab ID so it knows origin
    chrome.runtime.sendMessage({ ...msg, source: 'service-worker', tabId });
    console.log('[SW] Message forwarded to offscreen');
  } catch (err) {
    console.error('[SW] handleTTSFromContent error:', err);
  }
}

function broadcastToContentScripts(msg) {
  // Remove source field before sending to content scripts
  const { source, ...payload } = msg;
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
    }
  });

  // Clean up download tracking on completion
  if (msg.type === 'download-complete') {
    const key = `download-${msg.voiceId || 'model'}`;
    activeDownloads.delete(key);
  }
}

// Startup: placeholder for future startup logic
chrome.runtime.onInstalled.addListener(() => {
  // Cache verification happens lazily on first play
});
