import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createState } from '../src/state.js';
import { buildParagraph } from '../src/content-paragraphs.js';

let state, paragraphs, highlights;
const paragraphHighlight = () => CSS.highlights.get('pocket-speechify-paragraph');
const wordHighlight = () => CSS.highlights.get('pocket-speechify-word');
const textOf = highlight => [...highlight].map(range => range.toString()).join('');

beforeEach(async () => {
  vi.resetModules();
  // happy-dom has no Custom Highlight API. Ranges and DOM stay real.
  vi.stubGlobal('CSS', { highlights: new Map() });
  vi.stubGlobal('Highlight', class extends Set { constructor(...ranges) { super(ranges); } });
  document.body.innerHTML = '<p>First sentence. Next sentence.</p><p>Another paragraph.</p>';
  paragraphs = [...document.querySelectorAll('p')].map(element => buildParagraph(element, element.textContent));
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 100, bottom: 120, left: 20, width: 60, height: 20,
  });
  state = createState();
  const { initHighlights } = await import('../src/highlight.js');
  highlights = initHighlights(state, paragraphs);
  state.dispatch({ playback: 'playing', currentParagraphIndex: 0, currentWordIndex: 1 });
});

afterEach(() => {
  state.reset();
  highlights?.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.body.removeAttribute('style');
});

describe('paragraph and native word highlights', () => {
  it('anchors highlights to DOM ranges instead of body-relative rectangles', () => {
    document.body.style.cssText = 'position:relative; margin:80px 70px';
    expect(textOf(paragraphHighlight())).toBe('First sentence. Next sentence.');
    expect(textOf(wordHighlight())).toBe('sentence.');
    expect(document.querySelector('[data-ps-highlight="word"]')).toBeNull();
    expect(wordHighlight().priority).toBeGreaterThan(paragraphHighlight().priority);
  });

  it('refreshes replaced text nodes at the same indices while paused', () => {
    state.dispatch({ playback: 'paused' });
    const element = paragraphs[0].element;
    element.textContent = 'First sentence. Next sentence.';
    paragraphs[0] = buildParagraph(element, element.textContent);
    highlights.refresh();
    expect(textOf(paragraphHighlight())).toBe('First sentence. Next sentence.');
    expect([...wordHighlight()][0].startContainer).toBe(element.firstChild);
  });

  it('keeps the paragraph through a sentence gap and pause/resume', () => {
    const highlight = paragraphHighlight();
    state.dispatch({ currentWordIndex: null });
    expect(paragraphHighlight()).toBe(highlight);
    expect(wordHighlight()).toBeUndefined();
    state.dispatch({ playback: 'paused' });
    expect(paragraphHighlight()).toBe(highlight);
    state.dispatch({ playback: 'playing' });
    expect(paragraphHighlight()).toBe(highlight);
    state.dispatch({ currentWordIndex: 2 });
    expect(textOf(wordHighlight())).toBe('Next');
  });

  it('moves paragraphs even before a native word boundary', () => {
    state.dispatch({ currentParagraphIndex: 1, currentWordIndex: null });
    expect(textOf(paragraphHighlight())).toBe('Another paragraph.');
    expect(wordHighlight()).toBeUndefined();
  });

  it('clears only its own highlights on stop or paragraph removal', () => {
    const other = new Highlight();
    CSS.highlights.set('other-extension', other);
    state.dispatch({ currentParagraphIndex: null, currentWordIndex: null });
    expect(paragraphHighlight()).toBeUndefined();
    state.dispatch({ currentParagraphIndex: 0, currentWordIndex: 2 });
    expect(wordHighlight()).toBeDefined();
    state.dispatch({ playback: 'idle' });
    expect(paragraphHighlight()).toBeUndefined();
    expect(wordHighlight()).toBeUndefined();
    expect(CSS.highlights.get('other-extension')).toBe(other);
  });

  it('highlights only the selected fragment around a nested paragraph', () => {
    const element = document.createElement('blockquote');
    element.innerHTML = 'Before.<p>Middle.</p>After.';
    document.body.appendChild(element);
    paragraphs[0] = buildParagraph(element, 'After.', 'generic', 8);
    highlights.refresh();
    expect(textOf(paragraphHighlight())).toBe('After.');
  });
});

describe('auto-scroll', () => {
  function offscreenWord() {
    Range.prototype.getBoundingClientRect.mockReturnValue({
      top: window.innerHeight + 200, bottom: window.innerHeight + 220, left: 20, width: 60, height: 20,
    });
  }

  it('keeps following through the scroll events of its own smooth scroll', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    offscreenWord();
    state.dispatch({ currentWordIndex: 2 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scrollend'));
    state.dispatch({ currentWordIndex: 3 });
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('stops following after a user scroll inside a container', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    paragraphs[0].element.dispatchEvent(new Event('scroll'));
    offscreenWord();
    state.dispatch({ currentWordIndex: 2 });
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
