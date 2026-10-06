import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initHoverPlayer } from '../src/hover-player.js';
import { extractContent } from '../src/content-extractor.js';
import { createState } from '../src/state.js';

let paragraphs, button, actions;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<p>First tweet.</p><p>Second tweet.</p><div id="host"></div>';
  const shadow = document.querySelector('#host').attachShadow({ mode: 'open' });
  paragraphs = extractContent();
  actions = { play: vi.fn() };
  initHoverPlayer(shadow, createState(), paragraphs, actions);
  button = shadow.querySelector('button');
  paragraphs[1].element.dispatchEvent(new Event('mouseenter'));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); });

it('plays the hovered paragraph after another paragraph is prepended', () => {
  paragraphs.unshift({ element: document.createElement('p'), text: 'Inserted.' });
  button.click();
  expect(actions.play).toHaveBeenCalledWith(2);
});

it('does not play a different paragraph when the hovered paragraph disappears', () => {
  paragraphs.splice(1, 1, { element: document.createElement('p'), text: 'Replacement.' });
  button.click();
  expect(actions.play).not.toHaveBeenCalled();
});
