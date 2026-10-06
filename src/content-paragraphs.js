/**
 * Build a paragraph from `text`, normally readText(element).text.
 * `paragraph.text` is trimmed, but word and sentence offsets index into the
 * full readText(element).text so they map directly onto the element's DOM text.
 * For a fragment, pass its slice and baseOffset in that full text. Paragraph
 * [startOffset, endOffset) bounds the trimmed slice; multiple paragraphs may
 * share an element and must not be keyed by element alone.
 */
export function buildParagraph(element, text, source = "generic", baseOffset = 0) {
	const rawText = String(text || "");
	const normalizedText = rawText.trim();
	if (!normalizedText) return null;
	const leading = baseOffset + rawText.length - rawText.trimStart().length;
	const sentences = splitSentences(normalizedText, leading);
	if (sentences.length === 0) return null;
	const words = sentences.flatMap((sentence) => sentence.words);
	return {
		element, text: normalizedText, sentences, words, source,
		startOffset: leading, endOffset: leading + normalizedText.length,
	};
}

export function replaceParagraphs(target, next) {
	// Reuse only when DOM offsets and text are unchanged. Replacements and
	// changed whitespace must invalidate consumers even if trimmed text matches.
	const previous = new Map();
	for (const paragraph of target) {
		const list = previous.get(paragraph.element) || [];
		list.push(paragraph);
		previous.set(paragraph.element, list);
	}
	const reconciled = next.map(paragraph =>
		previous.get(paragraph.element)?.find(old =>
			old.text === paragraph.text && old.source === paragraph.source &&
			old.startOffset === paragraph.startOffset && old.endOffset === paragraph.endOffset &&
			old.twitterIdentity === paragraph.twitterIdentity &&
			old.textNodes.length === paragraph.textNodes.length &&
			old.textNodes.every((node, index) => node === paragraph.textNodes[index])
		) || paragraph
	);
	target.splice(0, target.length, ...reconciled);
	return target;
}

// Abbreviations that are usually followed by a capitalised word without
// ending the sentence ("Dr. Smith", "Fig. 3", "Jan. 5").
const NON_TERMINAL_ABBREVIATIONS = new Set(
	[
		"mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "vs", "no",
		"fig", "figs", "vol", "pp", "gen", "col", "lt", "sgt", "capt", "rev",
		"jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
	],
);

// Terminal punctuation, optional closing quotes/brackets, then whitespace.
// Boundaries are only ever placed at whitespace, which keeps per-sentence
// \S+ words identical to the paragraph-level \S+ words used for TTS indices.
const BOUNDARY = /[.!?…]+["'”’»)\]]*(?=\s)/g;

function isSentenceBoundary(text, punctuationIndex, afterIndex) {
	const next = text.slice(afterIndex).trimStart()[0];
	if (!next || /\p{Ll}/u.test(next)) return false;
	const token = text.slice(0, punctuationIndex).split(/\s/).pop() || "";
	if (text[punctuationIndex] !== ".") return true;
	const bare = token.replace(/^["'“‘«(\[]+/, "");
	if (/^\p{L}$/u.test(bare)) return false; // initials: "J. K. Rowling"
	return !NON_TERMINAL_ABBREVIATIONS.has(bare.toLowerCase());
}

function splitSentences(text, baseOffset) {
	const sentences = [];
	let start = 0;
	const push = (end) => {
		const body = text.slice(start, end);
		const leading = body.length - body.trimStart().length;
		const sentenceText = body.trim();
		if (sentenceText) {
			const offset = baseOffset + start + leading;
			sentences.push({
				text: sentenceText,
				startOffset: offset,
				words: splitWords(sentenceText, offset),
			});
		}
		start = end;
	};

	for (const match of text.matchAll(BOUNDARY)) {
		const end = match.index + match[0].length;
		if (isSentenceBoundary(text, match.index, end)) push(end);
	}
	push(text.length);
	return sentences;
}

function splitWords(sentenceText, sentenceOffset) {
	const words = [];
	const re = /\S+/g;
	let match;
	while ((match = re.exec(sentenceText))) {
		words.push({
			text: match[0],
			startOffset: sentenceOffset + match.index,
			endOffset: sentenceOffset + match.index + match[0].length,
		});
	}
	return words;
}
