export const TEXT_RULES_KEY = 'pocket-speechify-text-rules';

export const DEFAULT_TEXT_RULES = [
  { name: 'Remove soft hyphens', pattern: '\\u00ad', flags: 'g', replacement: '', enabled: true },
  { name: 'Non-breaking spaces', pattern: '[\\u00a0\\u202f]', flags: 'g', replacement: ' ', enabled: true },
  { name: 'Collapse whitespace', pattern: '\\s+', flags: 'g', replacement: ' ', enabled: true },
];

function isRule(rule) {
  return rule && ['name', 'pattern', 'flags', 'replacement'].every(key => typeof rule[key] === 'string') &&
    typeof rule.enabled === 'boolean';
}

export function textRuleError(rule) {
  if (!isRule(rule)) return 'Invalid rule fields.';
  if (!rule.pattern) return 'Enter a regex pattern.';
  if (/[^gimsu]/.test(rule.flags)) return 'Supported flags: g, i, m, s, u.';
  try {
    new RegExp(rule.pattern, rule.flags);
    return '';
  } catch (error) {
    return error.message;
  }
}

export async function loadTextRules(storage = chrome.storage.local) {
  const stored = await storage.get(TEXT_RULES_KEY);
  const rules = stored[TEXT_RULES_KEY];
  // An empty saved list means no rules, not "restore defaults".
  return (Array.isArray(rules) ? rules.filter(isRule) : DEFAULT_TEXT_RULES).map(rule => ({ ...rule }));
}

// Track UTF-16 offsets (the same units as RegExp and DOM Range) through every
// replacement. Captures retain their exact origins; new literal text belongs
// to the first non-whitespace character matched. Insertions have no page word.
export function preprocessText(input, rules) {
  let text = input;
  let sourceOffsets = Array.from({ length: input.length }, (_, index) => index);

  for (const rule of rules) {
    if (!rule.enabled || textRuleError(rule)) continue;
    const regex = new RegExp(rule.pattern, rule.flags.includes('g') ? rule.flags + 'd' : rule.flags + 'gd');
    const parts = [];
    const offsets = [];
    const append = (value, origins) => {
      parts.push(value);
      for (const origin of origins) offsets.push(origin);
    };
    const copy = (start, end) => append(text.slice(start, end), sourceOffsets.slice(start, end));
    let cursor = 0;

    for (const match of text.matchAll(regex)) {
      const start = match.index;
      const end = start + match[0].length;
      const first = match[0].search(/\S/);
      const origin = match[0].length ? sourceOffsets[start + Math.max(0, first)] : null;
      const literal = value => append(value, Array(value.length).fill(origin));
      const capture = range => { if (range) copy(...range); };
      copy(cursor, start);

      // JavaScript replacement-string syntax, with source tracking for captures.
      let replacementCursor = 0;
      for (const token of rule.replacement.matchAll(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g)) {
        literal(rule.replacement.slice(replacementCursor, token.index));
        const key = token[1];
        if (key === '$') literal('$');
        else if (key === '&') copy(start, end);
        else if (key === '`') copy(0, start);
        else if (key === "'") copy(end, text.length);
        else if (key.startsWith('<') && match.groups) capture(match.indices.groups[key.slice(1, -1)]);
        else if (/^\d/.test(key)) {
          let index = Number(key);
          let suffix = '';
          if (index >= match.length && key.length === 2) {
            index = Number(key[0]);
            suffix = key[1];
          }
          if (index > 0 && index < match.length) {
            capture(match.indices[index]);
            literal(suffix);
          } else literal(token[0]);
        } else literal(token[0]);
        replacementCursor = token.index + token[0].length;
      }
      literal(rule.replacement.slice(replacementCursor));
      cursor = end;
      if (!rule.flags.includes('g')) break;
    }
    copy(cursor, text.length);
    text = parts.join('');
    sourceOffsets = offsets;
  }

  return { text, sourceOffsets };
}
