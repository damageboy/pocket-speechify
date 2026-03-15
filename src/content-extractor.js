const BLOCK_TAGS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE']);
const SKIP_TAGS = new Set(['NAV', 'FOOTER', 'HEADER', 'ASIDE', 'SCRIPT', 'STYLE', 'NOSCRIPT']);

export function extractContent() {
  const paragraphs = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        if (node.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
        if (node.offsetParent === null && node.tagName !== 'BODY') return NodeFilter.FILTER_REJECT;
        if (BLOCK_TAGS.has(node.tagName)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
    }
  );

  let node;
  while (node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (!text) continue;
    const sentences = splitSentences(text);
    if (sentences.length === 0) continue;
    paragraphs.push({ element: node, text, sentences });
  }

  return paragraphs;
}

function splitSentences(text) {
  const raw = text.split(/([.!?]+(?:\s+|$))/);
  const sentences = [];
  let offset = 0;

  for (let i = 0; i < raw.length; i += 2) {
    const body = raw[i] || '';
    const delimiter = raw[i + 1] || '';
    const sentenceText = (body + delimiter).trim();
    if (!sentenceText) {
      offset += body.length + delimiter.length;
      continue;
    }
    const words = splitWords(sentenceText, offset);
    sentences.push({ text: sentenceText, startOffset: offset, words });
    offset += body.length + delimiter.length;
  }

  return sentences;
}

function splitWords(sentenceText, sentenceOffset) {
  const words = [];
  const re = /\S+/g;
  let match;
  while (match = re.exec(sentenceText)) {
    words.push({
      text: match[0],
      startOffset: sentenceOffset + match.index,
      endOffset: sentenceOffset + match.index + match[0].length,
    });
  }
  return words;
}
