import { loadTextRules, TEXT_RULES_KEY, textRuleError } from './text-rules.js';

// A separate pane keeps regex editing and its unsaved draft out of the player.
export async function renderTextRulesSettings(container) {
  container.textContent = 'Loading text rules…';
  let rules;
  try {
    rules = await loadTextRules();
  } catch {
    container.textContent = 'Could not load text rules. Close settings and try again.';
    return;
  }
  container.replaceChildren();
  const form = document.createElement('form');
  form.className = 'text-rules';
  const description = document.createElement('p');
  description.className = 'settings-field-desc';
  description.textContent = 'Rules run top to bottom on each paragraph before speech. They apply to all sites and languages; the page itself stays unchanged.';
  const scrollHint = document.createElement('p');
  scrollHint.className = 'text-rules-scroll-hint settings-field-desc';
  scrollHint.textContent = 'Scroll the table sideways to see replacements and actions.';
  const help = document.createElement('p');
  help.className = 'settings-field-desc text-rules-help';
  help.textContent = 'Use regex without /slashes/. Flags: g = all matches, i = ignore case; m, s and u are also supported. Replacements support $1, $<name> and $&. Leave a replacement empty to remove matches. Keep patterns simple to avoid slow processing.';
  const scroller = document.createElement('div');
  scroller.className = 'text-rules-scroll';
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'region');
  scroller.setAttribute('aria-label', 'Text rules table');
  const table = document.createElement('table');
  table.className = 'text-rules-table';
  const head = document.createElement('thead');
  const header = document.createElement('tr');
  for (const label of ['#', 'On', 'Rule', 'Find (regex)', 'Flags', 'Replace with', 'Actions']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    header.append(th);
  }
  head.append(header);
  const body = document.createElement('tbody');
  table.append(head, body);
  scroller.append(table);
  const empty = document.createElement('p');
  empty.className = 'settings-field-desc';
  empty.textContent = 'No rules. Text will be sent unchanged. Add a rule to start preprocessing.';
  const status = document.createElement('p');
  status.className = 'text-rules-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Save rules to apply changes to the next paragraph submitted.';
  let dirty = false;
  let saving = false;

  function button(text, label, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'text-rules-button';
    element.textContent = text;
    element.setAttribute('aria-label', label);
    element.title = label;
    element.addEventListener('click', () => {
      console.log(`[Pocket Speechify] ${label} clicked`);
      action();
    });
    return element;
  }

  const add = button('Add rule', 'Add rule', () => {
    rules.push({ name: 'New rule', pattern: '', flags: 'g', replacement: '', enabled: true });
    changed();
    renderRows();
    body.lastElementChild.querySelector('[data-field="pattern"]').focus();
  });
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'text-rules-button text-rules-save';
  save.textContent = 'Save rules';
  const toolbar = document.createElement('div');
  toolbar.className = 'text-rules-toolbar';
  toolbar.append(add, save);

  function validate() {
    let invalid = false;
    rules.forEach((rule, index) => {
      const error = textRuleError(rule);
      invalid ||= Boolean(error);
      const row = body.children[index];
      row.querySelector('.text-rule-error').textContent = error;
      const spaces = rule.replacement.length;
      row.querySelector('.text-rule-replacement-hint').textContent = /^ +$/.test(rule.replacement)
        ? `${spaces} ${spaces === 1 ? 'space' : 'spaces'}` : '';
      for (const key of ['pattern', 'flags']) {
        row.querySelector(`[data-field="${key}"]`).setAttribute('aria-invalid', String(Boolean(error)));
      }
    });
    save.disabled = invalid || saving;
  }

  function changed() {
    dirty = true;
    status.textContent = 'Unsaved changes. Save rules before closing settings.';
  }

  function renderRows() {
    body.replaceChildren();
    empty.hidden = rules.length > 0;
    rules.forEach((rule, index) => {
      const row = document.createElement('tr');
      const number = document.createElement('td');
      number.textContent = index + 1;
      row.append(number);
      for (const [key, label] of [['enabled', 'Enable'], ['name', 'Name'], ['pattern', 'Pattern'], ['flags', 'Flags'], ['replacement', 'Replacement']]) {
        const cell = document.createElement('td');
        const input = document.createElement('input');
        input.type = key === 'enabled' ? 'checkbox' : 'text';
        input.dataset.field = key;
        input.setAttribute('aria-label', `${label} rule ${index + 1}`);
        input.spellcheck = false;
        input.autocomplete = 'off';
        if (key === 'enabled') input.checked = rule.enabled;
        else input.value = rule[key];
        if (key === 'replacement') input.placeholder = '(remove matches)';
        input.addEventListener('input', () => {
          console.log(`[Pocket Speechify] Text rule ${index + 1} ${key} triggered`);
          rule[key] = key === 'enabled' ? input.checked : input.value;
          changed();
          validate();
        });
        cell.append(input);
        if (key === 'pattern') {
          const error = document.createElement('span');
          error.className = 'text-rule-error';
          error.id = `text-rule-error-${index}`;
          input.setAttribute('aria-describedby', error.id);
          cell.append(error);
        }
        if (key === 'replacement') {
          const hint = document.createElement('span');
          hint.className = 'text-rule-replacement-hint';
          hint.id = `text-rule-replacement-${index}`;
          input.setAttribute('aria-describedby', hint.id);
          cell.append(hint);
        }
        row.append(cell);
      }
      const actions = document.createElement('td');
      for (const [label, delta, symbol] of [['up', -1, '↑'], ['down', 1, '↓']]) {
        const move = button(symbol, `Move rule ${index + 1} ${label}`, () => {
          [rules[index], rules[index + delta]] = [rules[index + delta], rules[index]];
          changed();
          renderRows();
          body.children[index + delta].querySelector('[data-field="name"]').focus();
        });
        move.disabled = index + delta < 0 || index + delta >= rules.length;
        actions.append(move);
      }
      actions.append(button('×', `Remove rule ${index + 1}`, () => {
        rules.splice(index, 1);
        changed();
        renderRows();
        (body.children[Math.min(index, rules.length - 1)]?.querySelector('[data-field="name"]') ?? add).focus();
      }));
      row.append(actions);
      body.append(row);
    });
    validate();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    console.log('[Pocket Speechify] Save text rules triggered');
    if (saving || rules.some(rule => textRuleError(rule))) return;
    saving = true;
    dirty = false;
    validate();
    try {
      await chrome.storage.local.set({ [TEXT_RULES_KEY]: rules.map(rule => ({ ...rule })) });
      if (!dirty) status.textContent = 'Saved. Rules apply to the next paragraph submitted.';
    } catch {
      dirty = true;
      status.textContent = 'Could not save rules. Your changes are still here; try saving again.';
    } finally {
      saving = false;
      validate();
    }
  });

  form.append(description, scrollHint, scroller, empty, toolbar, status, help);
  container.append(form);
  renderRows();
}
