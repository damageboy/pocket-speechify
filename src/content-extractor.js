import { buildParagraph, replaceParagraphs } from "./content-paragraphs.js";
import { PARAGRAPH_TAGS, readText, isExcludedElement, isContentMutation } from "./dom-utils.js";
import { getSiteExtractor } from "./site-extractors/index.js";

const SKIP_TAGS = new Set([
	"NAV",
	"FOOTER",
	"HEADER",
	"ASIDE",
	"SCRIPT",
	"STYLE",
	"NOSCRIPT",
]);

export { buildParagraph, replaceParagraphs } from "./content-paragraphs.js";

export function extractContent(doc = document) {
	return extractGenericContent(doc);
}

export function createContentSource(
	url = new URL(location.href),
	doc = document,
) {
	const siteExtractor = getSiteExtractor(url);
	if (siteExtractor) return siteExtractor.createContentSource(doc, url);
	return createGenericContentSource(doc);
}

export function createGenericContentSource(doc = document) {
	const paragraphs = extractGenericContent(doc);
	const listeners = new Set();
	let refreshTimer = null;
	const metadata = {
		hasPlayableContent: false,
		autoShow: false,
		dynamic: true,
		playbackMode: "continuous",
	};
	function refresh({ notifyOnChange = true } = {}) {
		const previous = paragraphs.slice();
		replaceParagraphs(paragraphs, extractGenericContent(doc));
		const changed = previous.length !== paragraphs.length ||
			previous.some((paragraph, index) => paragraph !== paragraphs[index]);
		console.log(`[Pocket Speechify] Generic extractor refresh triggered: paragraphs=${paragraphs.length}, changed=${changed}`);
		if (changed && notifyOnChange) {
			listeners.forEach(listener => listener({ paragraphs, metadata }));
		}
		return paragraphs;
	}
	const observer = new MutationObserver(mutations => {
		if (!mutations.some(mutation => isContentMutation(mutation, "p,li,h1,h2,h3,h4,h5,h6,blockquote"))) return;
		// Batch bursts without waiting indefinitely for a streaming page to settle.
		if (refreshTimer !== null) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			refresh();
		}, 100);
	});
	if (doc.body) observer.observe(doc.body, {
		subtree: true, childList: true, characterData: true, attributes: true,
		attributeFilter: ["style", "class", "hidden", "aria-hidden"],
	});
	return {
		site: "generic",
		metadata,
		getParagraphs() {
			return paragraphs;
		},
		refresh,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		destroy() {
			clearTimeout(refreshTimer);
			observer.disconnect();
			listeners.clear();
		},
	};
}

function extractGenericContent(doc) {
	const paragraphs = [];
	function visit(element) {
		if (SKIP_TAGS.has(element.tagName) || isExcludedElement(element)) return;
		if (!PARAGRAPH_TAGS.has(element.tagName)) {
			for (const child of element.children) visit(child);
			return;
		}
		const { text, parts, segments } = readText(element);
		for (const part of parts) {
			if (part.element) visit(part.element);
			else {
				const paragraph = buildParagraph(element, text.slice(part.startOffset, part.endOffset), "generic", part.startOffset);
				if (paragraph) {
					paragraph.textNodes = segments.map(segment => segment.node);
					paragraphs.push(paragraph);
				}
			}
		}
	}
	if (doc.body) visit(doc.body);
	return paragraphs;
}
