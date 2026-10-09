import { beforeEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { initSidePanels } from '../src/side-panels.js';
import { createState } from '../src/state.js';

beforeEach(() => {
  fakeBrowser.reset();
  document.body.replaceChildren();
});

it('offers upstream model variants and ranks voices by base language for dated models', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div class="pill-container"></div>';
  const state = createState({ selectedModelId: 'english_2026-09' });
  const actions = { setLanguage: vi.fn(), setModel: vi.fn() };
  initSidePanels(shadow, state, actions);
  state.dispatch({ panelOpen: 'voice' });

  const select = shadow.querySelector('.language-selector');
  expect([...select.options].map(option => option.value)).toEqual(['english', 'dutch', 'french', 'german', 'italian', 'portuguese', 'spanish']);
  const model = shadow.querySelector('.model-selector');
  expect([...model.options].map(option => option.value)).toContain('english_2026-09_24l');
  expect([...model.options].map(option => option.value)).not.toContain('french_24l');
  const names = [...shadow.querySelectorAll('.voice-name')].map(node => node.textContent);
  expect(names[0]).toBe('Alba');
  expect(shadow.querySelector('.voice-lang').textContent).toBe('🇬🇧 English · default');
  expect(names.indexOf('Vera')).toBeLessThan(names.indexOf('Daan'));

  select.value = 'dutch';
  select.dispatchEvent(new Event('change'));
  expect(actions.setLanguage).toHaveBeenCalledWith('dutch');
  state.dispatch({ activeLanguage: 'dutch', selectedModelId: 'dutch_24l', voiceId: 'daan' });
  expect([...model.options].map(option => option.value)).toEqual(['dutch', 'dutch_24l']);
  expect(model.value).toBe('dutch_24l');
  expect(shadow.querySelector('.voice-name').textContent).toBe('Daan');
  expect(shadow.querySelector('.voice-lang').textContent).toBe('🇳🇱 Dutch · default');
});
