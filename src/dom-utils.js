export function createRangeFromOffsets(element, startOffset, endOffset) {
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let charCount = 0;
  let startSet = false;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const nodeLen = node.textContent.length;

    if (!startSet && charCount + nodeLen > startOffset) {
      range.setStart(node, startOffset - charCount);
      startSet = true;
    }
    if (startSet && charCount + nodeLen >= endOffset) {
      range.setEnd(node, endOffset - charCount);
      return range;
    }
    charCount += nodeLen;
  }
  return range;
}

export function scrollToCenter(rect) {
  const absoluteTop = rect.top + window.scrollY;
  window.scrollTo({ top: absoluteTop - window.innerHeight / 2, behavior: 'smooth' });
}
