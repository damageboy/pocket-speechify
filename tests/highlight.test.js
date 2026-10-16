import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createState } from '../src/state.js';
import { buildParagraph } from '../src/content-paragraphs.js';

let state, paragraphs, highlights;
const paragraphHighlight = () => CSS.highlights.get('pocket-speechify-paragraph');
const wordHighlight = () => CSS.highlights.get('pocket-speechify-word');
const textOf = highlight => [...highlight].map(range => range.toString()).join('');

function highlightStyle(name) {
  // happy-dom also omits ::highlight rules from CSSStyleSheet.cssRules.
  const css = document.querySelector('[data-ps-highlight="style"]').textContent;
  const element = document.createElement('span');
  element.style.cssText = css.match(new RegExp(`::highlight\\(pocket-speechify-${name}\\)\\s*\\{([^}]+)\\}`))[1];
  return element.style;
}

// Independent WCAG relative-luminance calculation on the emitted CSS colors.
function contrast(foreground, background) {
  const luminance = color => {
    const rgb = color.startsWith('#')
      ? color.slice(1).match(/../g).map(value => parseInt(value, 16))
      : color.match(/[\d.]+/g).slice(0, 3).map(Number);
    const linear = rgb.map(channel => channel / 255).map(value =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

beforeEach(async () => {
  vi.resetModules();
  // happy-dom has no Custom Highlight API. Ranges and DOM stay real.
  vi.stubGlobal('CSS', { highlights: new Map() });
  vi.stubGlobal('Highlight', class extends Set { constructor(...ranges) { super(ranges); } });
  document.body.innerHTML = '<p>First sentence. Next sentence.</p><p>Another paragraph.</p>';
  document.body.style.cssText = 'background-color:rgb(255,255,255);color:rgb(0,0,0)';
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

describe('highlight readability', () => {
  it.each([
    ['rgb(255,255,255)', 'rgb(0,0,0)', 'rgba(0, 0, 0, 0.02)', '#000000'],
    ['rgb(0,0,0)', 'rgb(255,255,255)', 'rgba(255, 255, 255, 0.02)', '#ffffff'],
  ])('composites translucent backgrounds over %s before choosing a palette', (background, color, tint, text) => {
    document.body.style.cssText = `background-color:${background};color:${color}`;
    paragraphs[0].element.style.backgroundColor = tint;
    highlights.refresh();
    expect(contrast(text, highlightStyle('paragraph').backgroundColor)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['rgb(255,255,255)', 'rgb(50,50,50)', 'rgb(35,75,130)'],
    ['rgb(20,20,20)', 'rgb(230,230,230)', 'rgb(170,195,240)'],
  ])('keeps both fills readable for body text and an inline link on %s', (background, color, linkColor) => {
    document.body.style.cssText = `background-color:${background};color:${color}`;
    const element = paragraphs[0].element;
    element.innerHTML = `First <a style="color:${linkColor}">sentence.</a> Next sentence.`;
    paragraphs[0] = buildParagraph(element, element.textContent);
    highlights.refresh();
    for (const name of ['paragraph', 'word']) {
      const style = highlightStyle(name);
      expect(style.color).toBe(''); // Never recolor page text to make a fill pass.
      for (const text of [color, linkColor]) {
        expect(contrast(text, style.backgroundColor)).toBeGreaterThanOrEqual(7);
      }
    }
    expect(highlightStyle('paragraph').backgroundColor).not.toBe(highlightStyle('word').backgroundColor);
  });

  it('leaves mixed light/dark text backgrounds intact when no shared readable fill exists', () => {
    const element = paragraphs[0].element;
    element.innerHTML = 'First <code style="color:rgb(255,255,255);background-color:rgb(0,0,0)">sentence.</code> Next sentence.';
    paragraphs[0] = buildParagraph(element, element.textContent);
    highlights.refresh();
    expect(highlightStyle('paragraph').backgroundColor).toBe('transparent');
    expect(highlightStyle('word').backgroundColor).toBe('transparent');
    expect(highlightStyle('word').textDecoration).toContain('underline');
  });

  it('uses an underline instead of obscuring text over an unknown gradient', () => {
    paragraphs[0].element.style.backgroundImage = 'linear-gradient(white, black)';
    highlights.refresh();
    expect(highlightStyle('paragraph').backgroundColor).toBe('transparent');
    expect(highlightStyle('word').backgroundColor).toBe('transparent');
    expect(highlightStyle('word').textDecoration).toContain('underline');
  });

  it('adapts colors at the next word when the page theme changes', () => {
    document.body.style.cssText = 'background-color:rgb(20,20,20);color:rgb(230,230,230)';
    state.dispatch({ currentWordIndex: 2 });
    for (const name of ['paragraph', 'word']) {
      expect(contrast('#e6e6e6', highlightStyle(name).backgroundColor)).toBeGreaterThanOrEqual(7);
    }
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

  it('follows a playback started after the user scrolled while idle', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    state.dispatch({ playback: 'idle' });
    window.dispatchEvent(new Event('scroll'));
    offscreenWord();
    state.dispatch({ playback: 'playing', currentParagraphIndex: 0, currentWordIndex: 2 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('stops following after a user scroll inside a container', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    paragraphs[0].element.dispatchEvent(new Event('scroll'));
    offscreenWord();
    state.dispatch({ currentWordIndex: 2 });
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
