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
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'TTS audio playback and WASM inference',
  });
  await offscreenCreating;
  offscreenCreating = null;
}

// Track active downloads for cross-tab coordination
// Key: cacheKey (e.g. "pocket-tts-v1/model/tts_b6369a24.safetensors")
// Value: { tabIds: Set<number> } — tabs waiting for this download
const activeDownloads = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // --- Messages FROM content scripts (have sender.tab) ---
  if (sender.tab) {
    // TTS control messages: forward to offscreen document
    if (msg.type.startsWith('tts-')) {
      handleTTSFromContent(msg, sender.tab.id);
    }
    return;
  }

  // --- Messages FROM offscreen document (source: 'offscreen') ---
  if (msg.source === 'offscreen') {
    // Events to broadcast to content scripts
    if (msg.type === 'download-progress' || msg.type === 'download-complete' ||
        msg.type === 'tts-word' || msg.type === 'tts-sentence-done' ||
        msg.type === 'tts-elapsed') {
      broadcastToContentScripts(msg);
    }
    return;
  }

  // Ignore messages from self or other extension contexts
});

async function handleTTSFromContent(msg, tabId) {
  // Cross-tab download coordination: if a download is already in progress
  // for the same asset, don't start another one
  if (msg.type === 'tts-play') {
    const downloadKey = `download-${msg.voiceId || 'model'}`;
    if (activeDownloads.has(downloadKey)) {
      activeDownloads.get(downloadKey).tabIds.add(tabId);
    } else {
      activeDownloads.set(downloadKey, { tabIds: new Set([tabId]) });
    }
  }

  await ensureOffscreenDocument();
  // Forward to offscreen doc with source tag so it knows origin
  chrome.runtime.sendMessage({ ...msg, source: 'service-worker' });
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
