import { buildParagraph, replaceParagraphs } from "../content-paragraphs.js";
import { isContentMutation, readText } from "../dom-utils.js";

const TWITTER_HOSTS = new Set([
	"x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com",
]);
const TWEET_SELECTOR = 'article[data-testid="tweet"]';
const TWEET_TEXT_SELECTOR = `${TWEET_SELECTOR} [data-testid="tweetText"][lang]`;
const REFRESH_DELAY_MS = 100;

export function matchesTwitterUrl(url) {
	const hostname = typeof url === "string" ? new URL(url).hostname : url?.hostname;
	return TWITTER_HOSTS.has(String(hostname || "").toLowerCase());
}

export function createTwitterContentSource(doc = document) {
	const listeners = new Set();
	const paragraphs = [];
	const metadata = {
		hasPlayableContent: false, autoShow: false, dynamic: true, playbackMode: "single",
	};
	let observer = null;
	let refreshTimer = null;

	function refresh({ notifyOnChange = true } = {}) {
		const previous = paragraphs.slice();
		replaceParagraphs(paragraphs, extractTwitterParagraphs(doc));
		const changed = previous.length !== paragraphs.length ||
			previous.some((paragraph, index) => paragraph !== paragraphs[index]);
		metadata.hasPlayableContent = paragraphs.length > 0;
		metadata.autoShow = paragraphs.length > 0;
		console.log(`[Pocket Speechify] Twitter extractor refresh triggered: accepted=${paragraphs.length}, changed=${changed}`);
		if (changed && notifyOnChange) {
			listeners.forEach(listener => listener({ paragraphs, metadata }));
		}
		return paragraphs;
	}

	refresh({ notifyOnChange: false });
	if (typeof MutationObserver !== "undefined" && doc.body) {
		observer = new MutationObserver(mutations => {
			if (!mutations.some(mutation => isContentMutation(mutation, TWEET_SELECTOR))) return;
			if (refreshTimer !== null) return;
			refreshTimer = setTimeout(() => {
				refreshTimer = null;
				refresh();
			}, REFRESH_DELAY_MS);
		});
		observer.observe(doc.body, {
			childList: true, subtree: true, characterData: true, attributes: true,
			attributeFilter: ["style", "class", "hidden", "aria-hidden", "lang", "data-testid"],
		});
	}

	return {
		site: "twitter", metadata,
		getParagraphs() { return paragraphs; },
		refresh,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		destroy() {
			clearTimeout(refreshTimer);
			observer?.disconnect();
			listeners.clear();
		},
	};
}

function extractTwitterParagraphs(doc) {
	const seenIdentities = new Set();
	const next = [];
	for (const element of doc.querySelectorAll(TWEET_TEXT_SELECTOR)) {
		// Shared reader keeps visibility and word offsets identical to highlights.
		const { text, segments } = readText(element);
		const article = element.closest(TWEET_SELECTOR);
		const statusUrl = article?.querySelector('a[href*="/status/"]')?.href || "";
		const identity = statusUrl ? `status:${statusUrl}` : `text:${text}`;
		if (seenIdentities.has(identity)) continue;
		const paragraph = buildParagraph(element, text, "twitter");
		if (!paragraph) continue;
		seenIdentities.add(identity);
		paragraph.twitterIdentity = identity;
		paragraph.textNodes = segments.map(segment => segment.node);
		next.push(paragraph);
	}
	return next;
}
