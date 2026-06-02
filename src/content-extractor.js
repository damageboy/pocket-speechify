import { buildParagraph, replaceParagraphs } from "./content-paragraphs.js";
import { getSiteExtractor } from "./site-extractors/index.js";

const BLOCK_TAGS = new Set([
	"P",
	"LI",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"BLOCKQUOTE",
]);
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
	const metadata = {
		hasPlayableContent: false,
		autoShow: false,
		dynamic: false,
		playbackMode: "continuous",
	};
	return {
		site: "generic",
		metadata,
		getParagraphs() {
			return paragraphs;
		},
		refresh() {
			replaceParagraphs(paragraphs, extractGenericContent(doc));
			metadata.hasPlayableContent = false;
			return paragraphs;
		},
		subscribe() {
			return () => {};
		},
		destroy() {},
	};
}

function extractGenericContent(doc) {
	const paragraphs = [];
	const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, {
		acceptNode(node) {
			if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
			if (node.getAttribute("aria-hidden") === "true")
				return NodeFilter.FILTER_REJECT;
			if (BLOCK_TAGS.has(node.tagName)) {
				if (node.offsetParent === null && node.tagName !== "BODY") {
					return NodeFilter.FILTER_REJECT;
				}
				return NodeFilter.FILTER_ACCEPT;
			}
			return NodeFilter.FILTER_SKIP;
		},
	});

	let node;
	while ((node = walker.nextNode())) {
		const paragraph = buildParagraph(node, node.textContent, "generic");
		if (!paragraph) continue;
		paragraphs.push(paragraph);
	}

	return paragraphs;
}
