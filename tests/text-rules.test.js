import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_RULES, loadTextRules, preprocessText, textRuleError } from '../src/text-rules.js';

const rule = (pattern, replacement, flags = 'g') => ({ name: 'Test', enabled: true, pattern, replacement, flags });

describe('speech text rules', () => {
  it('cleans typography without expanding language-specific words or removing content', () => {
    const result = preprocessText('A\u00a0co\u00adoperative.\n\tDr. Müller paid €3.14 [12].', DEFAULT_TEXT_RULES);
    expect(result.text).toBe('A cooperative. Dr. Müller paid €3.14 [12].');
    expect(result.sourceOffsets[result.text.indexOf('Müller')]).toBe(21);
  });

  it('applies rules in order, respects flags and disabled rules, and maps expansions and deletions', () => {
    const result = preprocessText('Dr. Ada [12] met DR. Bo.', [
      rule('\\bDr\\.', 'Doctor', 'gi'),
      rule('Doctor', 'Medical doctor', ''),
      rule('\\[\\d+\\] *', ''),
      { ...rule('Ada', 'wrong'), enabled: false },
    ]);
    expect(result.text).toBe('Medical doctor Ada met Doctor Bo.');
    expect(result.sourceOffsets.slice(0, 14)).toEqual(Array(14).fill(0));
    expect(result.sourceOffsets[result.text.indexOf('Ada')]).toBe(4);
    expect(result.sourceOffsets[result.text.indexOf('met')]).toBe(13);
    expect(result.sourceOffsets[result.text.indexOf('Bo')]).toBe(21);
  });

  it('retains capture origins even when reordered by a second rule', () => {
    const result = preprocessText('red blue!', [
      rule('(?<first>red) (blue)', '$2 $<first> $$ $&'),
      rule('blue', 'azure', ''),
    ]);
    expect(result.text).toBe('azure red $ red blue!');
    expect(result.sourceOffsets.slice(0, 5)).toEqual([4, 4, 4, 4, 4]);
    expect(result.sourceOffsets.slice(6, 9)).toEqual([0, 1, 2]);
    expect(result.sourceOffsets.slice(12)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it.each([
    ['(?<=x)(a)', '$1-$10-$2', 'g', 'xaa', 'xa-a0-$2a'],
    ['(a)?b', '$1$<missing>', 'g', 'b', '$<missing>'],
    ['(?<a>a)?b', '$1$<missing>', 'g', 'b', ''],
    ['b', "$`-$&-$'", '', 'abc', 'aa-b-cc'],
    ['(?=.)', '+', 'gu', '🌍a', '+🌍+a'],
  ])('expands JavaScript replacement tokens for %s', (pattern, replacement, flags, text, expected) => {
    expect(preprocessText(text, [rule(pattern, replacement, flags)]).text).toBe(expected);
  });

  it('does not map zero-width insertions to an unrelated page word', () => {
    expect(preprocessText('Hi', [rule('^', 'Note: ')])).toEqual({
      text: 'Note: Hi', sourceOffsets: [null, null, null, null, null, null, 0, 1],
    });
  });

  it('rejects invalid regexes, empty patterns and unsupported flags without breaking speech', () => {
    for (const invalid of [rule('[', ''), rule('', ''), rule('a', '', 'gg'), rule('a', '', 'y')]) {
      expect(textRuleError(invalid)).not.toBe('');
      expect(preprocessText('abc', [invalid, rule('b', 'B')]).text).toBe('aBc');
    }
  });

  it('uses defaults only when no list was saved, preserving an intentionally empty list', async () => {
    const missing = await loadTextRules({ get: async () => ({}) });
    expect(preprocessText('a\u00a0b', missing).text).toBe('a b');
    const empty = await loadTextRules({ get: async () => ({ 'pocket-speechify-text-rules': [] }) });
    expect(preprocessText('a\u00a0b', empty).text).toBe('a\u00a0b');
  });
});
