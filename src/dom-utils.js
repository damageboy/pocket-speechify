// Elements extracted as standalone paragraphs. readText() skips nested ones so
// an outer block never repeats text that is also extracted on its own.
export const PARAGRAPH_TAGS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE']);

// Never read: non-rendered or non-text content.
const NON_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'CANVAS', 'IFRAME']);

// Block boundaries that would otherwise glue adjacent words together.
const SEPARATOR_TAGS = new Set([
  'BR', 'HR', 'DIV', 'SECTION', 'ARTICLE', 'TABLE', 'TR', 'TD', 'TH', 'UL', 'OL', 'DL', 'DT', 'DD',
  'PRE', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'DETAILS', 'SUMMARY', 'MAIN', 'FORM', 'FIELDSET',
]);

// Nodes the extension adds to the page (overlays, scroll-nav, player host).
export const OWN_NODE_SELECTOR = '#pocket-speechify-host, [data-ps-highlight], [data-ps-scrollnav]';

// Subtree exclusions cannot be overridden by a visible descendant.
export function isExcludedElement(el) {
  if (NON_TEXT_TAGS.has(el.tagName)) return true;
  if (el.matches(OWN_NODE_SELECTOR)) return true;
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
  return el.ownerDocument.defaultView?.getComputedStyle(el).display === 'none';
}

// Unlike display:none, visibility:hidden can be overridden by descendants.
// Do not use offsetParent/rects: fixed and display:contents text is readable.
export function isVisibleElement(el) {
  if (!el) return false;
  for (let current = el; current; current = current.parentElement) {
    if (isExcludedElement(current)) return false;
  }
  const visibility = el.ownerDocument.defaultView?.getComputedStyle(el).visibility;
  return visibility !== 'hidden' && visibility !== 'collapse';
}

export function isOwnNode(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(element?.closest(OWN_NODE_SELECTOR));
}

// Ignore our UI and mutations unrelated to the extracted blocks. Attribute
// changes on ancestors matter because CSS/aria visibility is inherited.
export function isContentMutation(mutation, selector) {
  if (isOwnNode(mutation.target)) return false;
  const element = mutation.target.nodeType === Node.ELEMENT_NODE
    ? mutation.target : mutation.target.parentElement;
  const containsBlock = node => node.nodeType === Node.ELEMENT_NODE &&
    !isOwnNode(node) && (node.matches(selector) || node.querySelector(selector));
  if (mutation.type === 'childList') {
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    if (nodes.length && nodes.every(isOwnNode)) return false;
    return Boolean(element?.closest(selector) || nodes.some(containsBlock));
  }
  return Boolean(element?.closest(selector) ||
    (mutation.type === 'attributes' && containsBlock(element)));
}

/**
 * Read the visible text of `root` the way it is extracted and highlighted.
 * Returns the text plus the start offset of every text node within it, so
 * offsets into `text` can be mapped back to DOM positions.
 * Synthetic separators ("\n") are inserted at <br> and block boundaries; they
 * are whitespace, so word offsets never fall on them.
 * `parts` interleaves own-text offset slices with nested paragraph elements,
 * allowing extraction to preserve DOM order without merging nested blocks.
 */
export function readText(root) {
  let text = '';
  const segments = [];
  const parts = [];
  let partStart = 0;

  function flush() {
    parts.push({ startOffset: partStart, endOffset: text.length });
    partStart = text.length;
  }

  function separate() {
    if (text && !/\s$/.test(text)) text += '\n';
  }

  function visit(node) {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!child.data || !isVisibleElement(child.parentElement)) continue;
        segments.push({ node: child, start: text.length });
        text += child.data;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (isExcludedElement(child)) continue;
        if (PARAGRAPH_TAGS.has(child.tagName)) {
          separate();
          flush();
          parts.push({ element: child });
          continue;
        }
        const isSeparator = SEPARATOR_TAGS.has(child.tagName);
        if (isSeparator) separate();
        visit(child);
        if (isSeparator) separate();
      }
    }
  }

  if (root && !isOwnNode(root)) visit(root);
  flush();
  return { text, segments, parts };
}

function locate(segments, offset, isEnd) {
  for (const { node, start } of segments) {
    const end = start + node.data.length;
    if (isEnd ? offset > start && offset <= end : offset >= start && offset < end) {
      return [node, offset - start];
    }
  }
  return null;
}

/** Map [startOffset, endOffset) in readText(element).text to a DOM Range, or null. */
export function createRangeFromOffsets(element, startOffset, endOffset) {
  const { segments } = readText(element);
  const start = locate(segments, startOffset, false);
  const end = locate(segments, endOffset, true);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(...start);
  range.setEnd(...end);
  return range;
}

// Smooth scrolling fires many scroll events. Track programmatic scrolls until
// `scrollend`, or until scroll events stop arriving (fallback when no scroll
// happens or `scrollend` is unsupported), so listeners can tell them apart
// from user scrolling.
const PROGRAMMATIC_SCROLL_IDLE_MS = 300;
let programmaticScroll = false;
let programmaticScrollTimer = null;

function armProgrammaticScrollTimer() {
  clearTimeout(programmaticScrollTimer);
  programmaticScrollTimer = setTimeout(endProgrammaticScroll, PROGRAMMATIC_SCROLL_IDLE_MS);
}

function endProgrammaticScroll() {
  programmaticScroll = false;
  clearTimeout(programmaticScrollTimer);
  window.removeEventListener('scroll', armProgrammaticScrollTimer);
  window.removeEventListener('scrollend', endProgrammaticScroll);
}

export function isProgrammaticScroll() {
  return programmaticScroll;
}

export function scrollToCenter(rect) {
  endProgrammaticScroll();
  programmaticScroll = true;
  window.addEventListener('scroll', armProgrammaticScrollTimer, { passive: true });
  window.addEventListener('scrollend', endProgrammaticScroll);
  armProgrammaticScrollTimer();
  const absoluteTop = rect.top + window.scrollY;
  window.scrollTo({ top: absoluteTop - window.innerHeight / 2, behavior: 'smooth' });
}
