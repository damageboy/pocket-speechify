import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extractContent } from '../src/content-extractor.js';

// In happy-dom, node.offsetParent is always null, which causes the extractor
// to reject all elements (line: if (node.offsetParent === null && node.tagName !== 'BODY') FILTER_REJECT).
// We patch offsetParent on each node using Object.defineProperty before extraction.
function makeOffsetParentNonNull(el) {
  Object.defineProperty(el, 'offsetParent', {
    get: () => document.body,
    configurable: true,
  });
}

function setBodyHtml(html) {
  document.body.innerHTML = html;
  // Patch all elements in body to have a non-null offsetParent
  document.body.querySelectorAll('*').forEach(el => makeOffsetParentNonNull(el));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('extractContent', () => {
  it('extracts paragraphs from simple <p> tags', () => {
    setBodyHtml('<p>Hello world. This is a test.</p><p>Second paragraph.</p>');
    const paragraphs = extractContent();
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0].text).toContain('Hello world');
    expect(paragraphs[1].text).toContain('Second paragraph');
  });

  it('each paragraph has element, text, sentences, and words', () => {
    setBodyHtml('<p>Hello world.</p>');
    const paragraphs = extractContent();
    expect(paragraphs.length).toBe(1);
    const p = paragraphs[0];
    expect(p.element).toBeDefined();
    expect(typeof p.text).toBe('string');
    expect(Array.isArray(p.sentences)).toBe(true);
    expect(Array.isArray(p.words)).toBe(true);
  });

  it('returns empty array for empty body', () => {
    document.body.innerHTML = '';
    const paragraphs = extractContent();
    expect(paragraphs).toEqual([]);
  });

  it('skips empty paragraphs', () => {
    setBodyHtml('<p></p><p>   </p><p>Real content.</p>');
    const paragraphs = extractContent();
    expect(paragraphs.length).toBe(1);
    expect(paragraphs[0].text).toContain('Real content');
  });

  it('skips elements with aria-hidden=true', () => {
    setBodyHtml('<p aria-hidden="true">Hidden</p><p>Visible</p>');
    const paragraphs = extractContent();
    expect(paragraphs.length).toBe(1);
    expect(paragraphs[0].text).toBe('Visible');
  });

  it('skips content inside SKIP_TAGS (nav, footer, header, aside, script, style)', () => {
    setBodyHtml(`
      <nav><p>Nav item</p></nav>
      <footer><p>Footer text</p></footer>
      <p>Main content.</p>
    `);
    document.body.querySelectorAll('*').forEach(el => makeOffsetParentNonNull(el));
    const paragraphs = extractContent();
    expect(paragraphs.length).toBe(1);
    expect(paragraphs[0].text).toBe('Main content.');
  });

  it('extracts from heading tags (h1-h6)', () => {
    setBodyHtml('<h1>Title here</h1><h2>Subtitle</h2><p>Body text.</p>');
    const paragraphs = extractContent();
    expect(paragraphs.length).toBe(3);
    expect(paragraphs[0].text).toBe('Title here');
    expect(paragraphs[1].text).toBe('Subtitle');
  });

  it('extracts from li and blockquote tags', () => {
    setBodyHtml('<ul><li>Item one</li><li>Item two</li></ul><blockquote>A quote.</blockquote>');
    const paragraphs = extractContent();
    expect(paragraphs.length).toBe(3);
  });

  it('splits text into sentences', () => {
    setBodyHtml('<p>First sentence. Second sentence! Third sentence?</p>');
    const paragraphs = extractContent();
    expect(paragraphs.length).toBe(1);
    const sentences = paragraphs[0].sentences;
    expect(sentences.length).toBe(3);
    expect(sentences[0].text).toContain('First sentence');
    expect(sentences[1].text).toContain('Second sentence');
    expect(sentences[2].text).toContain('Third sentence');
  });

  it('single sentence paragraph has one sentence', () => {
    setBodyHtml('<p>Just one sentence here.</p>');
    const paragraphs = extractContent();
    expect(paragraphs[0].sentences.length).toBe(1);
  });

  it('words are split correctly within sentences', () => {
    setBodyHtml('<p>Hello world.</p>');
    const paragraphs = extractContent();
    const words = paragraphs[0].words;
    expect(words.length).toBe(2);
    expect(words[0].text).toBe('Hello');
    expect(words[1].text).toBe('world.');
  });

  it('each word has startOffset and endOffset', () => {
    setBodyHtml('<p>Hello world.</p>');
    const paragraphs = extractContent();
    const words = paragraphs[0].words;
    expect(words[0]).toHaveProperty('startOffset');
    expect(words[0]).toHaveProperty('endOffset');
    expect(typeof words[0].startOffset).toBe('number');
    expect(typeof words[0].endOffset).toBe('number');
  });

  it('words flat list equals all words from all sentences', () => {
    setBodyHtml('<p>One two. Three four.</p>');
    const paragraphs = extractContent();
    const p = paragraphs[0];
    const sentenceWords = p.sentences.flatMap(s => s.words);
    expect(p.words).toEqual(sentenceWords);
  });

  it('returns only block-level content, not generic divs', () => {
    setBodyHtml('<div>Just a div</div><p>A paragraph.</p>');
    const paragraphs = extractContent();
    // div is not in BLOCK_TAGS, only p should be extracted
    expect(paragraphs.length).toBe(1);
    expect(paragraphs[0].text).toBe('A paragraph.');
  });
});
