const PROSE_TAGS = new Set(["P", "BLOCKQUOTE"]);
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const SKIP_TAGS = new Set([
	"NAV",
	"FOOTER",
	"HEADER",
	"ASIDE",
	"SCRIPT",
	"STYLE",
	"NOSCRIPT",
]);
const ARTICLE_METADATA_TYPES = new Set([
	"article",
	"newsarticle",
	"blogposting",
]);
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export function detectReadableArticle(doc, paragraphs, options = {}) {
	const documentRef = doc || document;
	const isVisible = options.isVisible || defaultIsVisible;
	const metadataFound = hasArticleMetadata(documentRef);
	const candidates = collectCandidateRoots(documentRef, isVisible);

	if (candidates.length === 0) {
		return buildResult({
			isReadableArticle: false,
			canPlayBestEffort: false,
			confidence: 0,
			root: null,
			proseWords: 0,
			proseBlockCount: 0,
			longProseBlockCount: 0,
			linkDensity: 1,
			proseParagraphIndexes: [],
			metadataFound,
		});
	}

	let best = null;
	for (const root of candidates) {
		const candidate = scoreCandidate({
			root,
			paragraphs: Array.isArray(paragraphs) ? paragraphs : [],
			isVisible,
			metadataFound,
		});

		if (
			!best ||
			candidate.confidence > best.confidence ||
			(candidate.confidence === best.confidence &&
				candidate.proseWords > best.proseWords)
		) {
			best = candidate;
		}
	}

	const isReadableArticle =
		best.confidence >= 0.65 &&
		best.proseWords >= 300 &&
		best.longProseBlockCount >= 3 &&
		best.linkDensity < 0.5;
	const canPlayBestEffort = best.proseWords >= 120 && best.proseBlockCount >= 2;

	return buildResult({
		...best,
		isReadableArticle,
		canPlayBestEffort,
		metadataFound,
	});
}

function scoreCandidate({ root, paragraphs, isVisible, metadataFound }) {
	const proseParagraphIndexes = [];
	let proseWords = 0;
	let proseBlockCount = 0;
	let longProseBlockCount = 0;

	paragraphs.forEach((paragraph, index) => {
		if (!paragraph?.element || !root.contains(paragraph.element)) return;
		if (!isVisible(paragraph.element)) return;
		if (hasSkippedOrHiddenAncestor(paragraph.element, root)) return;
		if (!isProseLikeBlock(paragraph)) return;

		const text = normalizeText(paragraph.text);
		const wordCount = getWordCount(paragraph);

		proseParagraphIndexes.push(index);
		proseWords += wordCount;
		proseBlockCount += 1;

		if (text.length >= 80 && wordCount >= 15) {
			longProseBlockCount += 1;
		}
	});

	const linkDensity = getLinkDensity(root, isVisible);
	const confidence = calculateConfidence({
		metadataFound,
		root,
		proseWords,
		longProseBlockCount,
		linkDensity,
	});

	return {
		root,
		confidence,
		proseWords,
		proseBlockCount,
		longProseBlockCount,
		linkDensity,
		proseParagraphIndexes,
	};
}

function isProseLikeBlock(paragraph) {
	const tagName = paragraph.element?.tagName;
	if (!PROSE_TAGS.has(tagName) && !HEADING_TAGS.has(tagName)) return false;

	const text = normalizeText(paragraph.text);
	const wordCount = getWordCount(paragraph);
	if (text.length < 40 || wordCount < 8) return false;
	if (HEADING_TAGS.has(tagName) && !/[.!?]$/.test(text)) return false;

	return true;
}

function getWordCount(paragraph) {
	if (Array.isArray(paragraph.words)) return paragraph.words.length;
	return countWords(paragraph.text);
}

function countWords(text) {
	const matches = normalizeText(text).match(/\S+/g);
	return matches ? matches.length : 0;
}

function calculateConfidence({
	metadataFound,
	root,
	proseWords,
	longProseBlockCount,
	linkDensity,
}) {
	let confidence = 0;

	if (metadataFound) confidence += 0.25;
	if (root.tagName === "ARTICLE") confidence += 0.2;
	if (root.tagName === "MAIN") confidence += 0.1;
	if (proseWords >= 300) confidence += 0.2;
	if (proseWords >= 600) confidence += 0.2;
	if (longProseBlockCount >= 3) confidence += 0.2;
	if (linkDensity < 0.35) confidence += 0.1;
	if (linkDensity >= 0.5) confidence -= 0.25;

	return clamp(confidence, 0, 1);
}

function collectCandidateRoots(doc, isVisible) {
	const roots = [];
	const addRoot = (root, requireVisible = true) => {
		if (!root || roots.includes(root)) return;
		if (requireVisible && !isVisible(root)) return;
		if (hasSkippedOrHiddenAncestor(root, null)) return;
		roots.push(root);
	};

	doc.querySelectorAll("article").forEach((root) => addRoot(root));
	doc.querySelectorAll("main").forEach((root) => addRoot(root));
	addRoot(doc.body, false);

	return roots;
}

function getLinkDensity(root, isVisible) {
	let linkChars = 0;
	let totalChars = 0;

	visitVisibleText(root, isVisible, (textNode) => {
		const textLength = normalizeText(textNode.nodeValue).length;
		if (textLength === 0) return;

		totalChars += textLength;
		if (hasAnchorAncestor(textNode.parentElement, root)) {
			linkChars += textLength;
		}
	});

	if (totalChars === 0) return 1;
	return linkChars / totalChars;
}

function visitVisibleText(node, isVisible, onText) {
	if (!node) return;

	if (node.nodeType === TEXT_NODE) {
		onText(node);
		return;
	}

	if (node.nodeType !== ELEMENT_NODE) return;
	if (hasSkippedOrHiddenSelf(node)) return;
	if (!isVisible(node)) return;

	node.childNodes.forEach((child) =>
		visitVisibleText(child, isVisible, onText),
	);
}

function hasAnchorAncestor(element, root) {
	for (
		let current = element;
		current && current !== root.parentElement;
		current = current.parentElement
	) {
		if (current.tagName === "A") return true;
		if (current === root) break;
	}
	return false;
}

function hasSkippedOrHiddenAncestor(element, stopAt) {
	for (let current = element; current; current = current.parentElement) {
		if (hasSkippedOrHiddenSelf(current)) return true;
		if (current === stopAt) break;
	}
	return false;
}

function hasSkippedOrHiddenSelf(element) {
	return (
		SKIP_TAGS.has(element.tagName) ||
		element.getAttribute("aria-hidden") === "true"
	);
}

function hasArticleMetadata(doc) {
	return (
		hasOpenGraphArticleType(doc) ||
		hasJsonLdArticleType(doc) ||
		hasItemtypeArticleType(doc)
	);
}

function hasOpenGraphArticleType(doc) {
	return Array.from(doc.querySelectorAll("meta")).some((meta) => {
		const keys = [meta.getAttribute("property"), meta.getAttribute("name")]
			.filter(Boolean)
			.map((value) => value.toLowerCase());
		const content = (meta.getAttribute("content") || "").trim().toLowerCase();
		return keys.includes("og:type") && content === "article";
	});
}

function hasJsonLdArticleType(doc) {
	return Array.from(
		doc.querySelectorAll('script[type="application/ld+json"]'),
	).some((script) => {
		try {
			return jsonLdHasArticleType(JSON.parse(script.textContent || "null"));
		} catch (_error) {
			return false;
		}
	});
}

function jsonLdHasArticleType(value) {
	if (Array.isArray(value)) return value.some(jsonLdHasArticleType);
	if (!value || typeof value !== "object") return false;

	if (jsonLdTypeMatches(value["@type"])) return true;

	return Object.entries(value).some(([key, nested]) => {
		if (key === "@type") return false;
		return jsonLdHasArticleType(nested);
	});
}

function jsonLdTypeMatches(value) {
	if (typeof value === "string") return isArticleType(value);
	if (Array.isArray(value)) return value.some(jsonLdTypeMatches);
	if (value && typeof value === "object") return jsonLdHasArticleType(value);
	return false;
}

function hasItemtypeArticleType(doc) {
	return Array.from(doc.querySelectorAll("[itemtype]")).some((element) =>
		isArticleType(element.getAttribute("itemtype")),
	);
}

function isArticleType(value) {
	const normalized = String(value || "").toLowerCase();
	return Array.from(ARTICLE_METADATA_TYPES).some((type) =>
		normalized.includes(type),
	);
}

function buildResult({
	isReadableArticle,
	canPlayBestEffort,
	confidence,
	root,
	proseWords,
	proseBlockCount,
	longProseBlockCount,
	linkDensity,
	proseParagraphIndexes,
	metadataFound,
}) {
	return {
		isReadableArticle,
		canPlayBestEffort,
		confidence,
		reason: [
			`confidence=${confidence.toFixed(2)}`,
			`proseWords=${proseWords}`,
			`proseBlocks=${proseBlockCount}`,
			`longProseBlocks=${longProseBlockCount}`,
			`linkDensity=${linkDensity.toFixed(2)}`,
			`root=${root ? root.tagName.toLowerCase() : "none"}`,
			`metadata=${metadataFound ? "yes" : "no"}`,
		].join(" "),
		proseParagraphIndexes,
	};
}

function normalizeText(text) {
	return String(text || "")
		.replace(/\s+/g, " ")
		.trim();
}

function defaultIsVisible(element) {
	return (
		!!element &&
		typeof element.getClientRects === "function" &&
		element.getClientRects().length > 0
	);
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}
