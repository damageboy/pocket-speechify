export function buildParagraph(element, text, source = "generic") {
	const normalizedText = String(text || "").trim();
	const sentences = splitSentences(normalizedText);
	if (!normalizedText || sentences.length === 0) return null;
	const words = sentences.flatMap((sentence) => sentence.words);
	return { element, text: normalizedText, sentences, words, source };
}

export function replaceParagraphs(target, next) {
	target.splice(0, target.length, ...next);
	return target;
}

function splitSentences(text) {
	const raw = text.split(/([.!?]+(?:\s+|$))/);
	const sentences = [];
	let offset = 0;

	for (let i = 0; i < raw.length; i += 2) {
		const body = raw[i] || "";
		const delimiter = raw[i + 1] || "";
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
	while ((match = re.exec(sentenceText))) {
		words.push({
			text: match[0],
			startOffset: sentenceOffset + match.index,
			endOffset: sentenceOffset + match.index + match[0].length,
		});
	}
	return words;
}
