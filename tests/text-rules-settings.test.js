import { beforeEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { renderTextRulesSettings } from '../src/text-rules-settings.js';
import { TEXT_RULES_KEY } from '../src/text-rules.js';

let host;
const click = label => [...host.querySelectorAll('button')].find(button => button.textContent === label).click();
const rows = () => [...host.querySelectorAll('tbody tr')];
const field = (row, name) => row.querySelector(`[data-field="${name}"]`);
function input(row, name, value) {
  const element = field(row, name);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
async function save() {
  click('Save rules');
  await vi.waitFor(() => expect(host.querySelector('[role="status"]').textContent).toContain('Saved'));
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.stubGlobal('chrome', fakeBrowser);
  document.body.replaceChildren();
  host = document.createElement('div');
  document.body.append(host);
});

it('shows defaults, saves edits, toggles and ordering, and persists deletion of every rule', async () => {
  await renderTextRulesSettings(host);
  expect(rows()).toHaveLength(3);
  expect(field(rows()[0], 'pattern').value).toBe('\\u00ad');
  click('Add rule');
  const added = rows().at(-1);
  input(added, 'name', 'Title');
  input(added, 'pattern', '\\bDr\\.');
  input(added, 'replacement', 'Doctor');
  added.querySelector('[aria-label="Move rule 4 up"]').click();
  field(rows()[0], 'enabled').click();
  await save();
  await renderTextRulesSettings(host);
  expect(field(rows()[0], 'enabled').checked).toBe(false);
  expect(field(rows()[2], 'replacement').value).toBe('Doctor');
  while (rows().length) rows()[0].querySelector('[aria-label^="Remove rule"]').click();
  await save();
  await renderTextRulesSettings(host);
  expect(rows()).toHaveLength(0);
  expect(host.textContent).toContain('No rules');
  expect((await chrome.storage.local.get(TEXT_RULES_KEY))[TEXT_RULES_KEY]).toEqual([]);
});

it('marks malformed regexes and blocks saving until fixed, while allowing empty replacements', async () => {
  await renderTextRulesSettings(host);
  input(rows()[1], 'pattern', '[');
  expect(field(rows()[1], 'pattern').getAttribute('aria-invalid')).toBe('true');
  expect(host.querySelector('button[type="submit"]').disabled).toBe(true);
  expect((await chrome.storage.local.get(TEXT_RULES_KEY))[TEXT_RULES_KEY]).toBeUndefined();
  input(rows()[1], 'pattern', '\\[\\d+\\]');
  input(rows()[1], 'replacement', '');
  await save();
  expect((await chrome.storage.local.get(TEXT_RULES_KEY))[TEXT_RULES_KEY][1].replacement).toBe('');
});

it('reports failed writes and retains the editable draft for retry', async () => {
  await renderTextRulesSettings(host);
  vi.spyOn(chrome.storage.local, 'set').mockRejectedValueOnce(new Error('Storage full'));
  input(rows()[0], 'name', 'Keep this draft');
  click('Save rules');
  await vi.waitFor(() => expect(host.querySelector('[role="status"]').textContent).toContain('Could not save'));
  expect(field(rows()[0], 'name').value).toBe('Keep this draft');
  await save();
});

it('does not offer to overwrite saved rules if loading fails', async () => {
  vi.spyOn(chrome.storage.local, 'get').mockRejectedValueOnce(new Error('Unavailable'));
  await renderTextRulesSettings(host);
  expect(host.textContent).toContain('Could not load');
  expect(host.querySelector('button[type="submit"]')).toBeNull();
});
