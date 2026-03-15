(async function initPocketSpeechify() {
  if (document.getElementById('pocket-speechify-host')) return;

  const host = document.createElement('div');
  host.id = 'pocket-speechify-host';
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483645; pointer-events: none;';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const cssUrl = chrome.runtime.getURL('css/player.css');
  const cssText = await fetch(cssUrl).then(r => r.text());
  const style = document.createElement('style');
  style.textContent = cssText;
  shadow.appendChild(style);

  const { createState } = await import(chrome.runtime.getURL('src/state.js'));
  const state = createState();

  // Task 3: Content extraction
  const { extractContent } = await import(chrome.runtime.getURL('src/content-extractor.js'));
  const paragraphs = extractContent();
  const totalWords = paragraphs.reduce((sum, p) =>
    sum + p.sentences.reduce((s, sent) => s + sent.words.length, 0), 0);
  const totalDurationSec = totalWords / (state.get().speed * 4);
  state.dispatch({ totalDurationSec });
  console.log(`[Pocket Speechify] Extracted ${paragraphs.length} paragraphs, ${totalWords} words, ~${Math.round(totalDurationSec)}s`);
})();
