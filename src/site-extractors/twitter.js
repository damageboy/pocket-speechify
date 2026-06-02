import { buildParagraph, replaceParagraphs } from "../content-paragraphs.js";

const TWITTER_HOSTS = new Set([
	"x.com",
	"www.x.com",
	"twitter.com",
	"www.twitter.com",
	"mobile.twitter.com",
]);

const TWEET_TEXT_SELECTOR =
	'article[data-testid="tweet"] [data-testid="tweetText"][lang]';
const REFRESH_DELAY_MS = 100;

export function matchesTwitterUrl(url) {
	const hostname =
		typeof url === "string" ? new URL(url).hostname : url?.hostname;
	return TWITTER_HOSTS.has(String(hostname || "").toLowerCase());
}

export function createTwitterContentSource(doc = document) {
	const listeners = new Set();
	const paragraphs = [];
	const metadata = {
		hasPlayableContent: false,
		autoShow: false,
		dynamic: true,
		playbackMode: "single",
	};
	let observer = null;
	let refreshTimer = null;

	function notify() {
		const payload = { paragraphs, metadata };
		listeners.forEach((listener) => listener(payload));
	}

	function refresh({ notifyOnChange = true } = {}) {
		const { next, diagnostics } = extractTwitterParagraphs(doc);
		const changed = paragraphSignature(paragraphs) !== paragraphSignature(next);
		replaceParagraphs(paragraphs, next);
		metadata.hasPlayableContent = paragraphs.length > 0;
		metadata.autoShow = paragraphs.length > 0;
		logRefreshDiagnostics(diagnostics, changed);
		if (changed && notifyOnChange) notify();
		return paragraphs;
	}

	function scheduleRefresh() {
		if (refreshTimer !== null) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			refresh();
		}, REFRESH_DELAY_MS);
	}

	refresh({ notifyOnChange: false });

	if (typeof MutationObserver !== "undefined" && doc.body) {
		observer = new MutationObserver(scheduleRefresh);
		observer.observe(doc.body, {
			childList: true,
			subtree: true,
			characterData: true,
		});
	}

	return {
		site: "twitter",
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
			if (refreshTimer !== null) {
				clearTimeout(refreshTimer);
				refreshTimer = null;
			}
			if (observer) observer.disconnect();
			listeners.clear();
		},
	};
}

function extractTwitterParagraphs(doc) {
	const seenText = new Set();
	const diagnostics = [];
	const next = [];
	const candidates = Array.from(doc.querySelectorAll(TWEET_TEXT_SELECTOR));

	candidates.forEach((element, index) => {
		const text = getTweetText(element);
		const context = getTweetContext(element, text, index);
		const hiddenReason = getHiddenReason(element);
		if (hiddenReason) {
			diagnostics.push({ ...context, accepted: false, reason: hiddenReason });
			return;
		}
		if (!text) {
			diagnostics.push({ ...context, accepted: false, reason: "empty-text" });
			return;
		}
		if (seenText.has(text)) {
			diagnostics.push({
				...context,
				accepted: false,
				reason: "duplicate-text",
			});
			return;
		}

		const paragraph = buildParagraph(element, text, "twitter");
		if (!paragraph) {
			diagnostics.push({
				...context,
				accepted: false,
				reason: "paragraph-build-failed",
			});
			return;
		}

		seenText.add(text);
		next.push(paragraph);
		diagnostics.push({
			...context,
			accepted: true,
			reason: "accepted",
			words: paragraph.words.length,
			sentences: paragraph.sentences.length,
		});
	});

	return { next, diagnostics };
}

function getTweetText(element) {
	return (element.innerText || element.textContent || "").trim();
}

function getHiddenReason(element) {
	if (!element) return "missing-element";
	for (let current = element; current; current = current.parentElement) {
		if (current.getAttribute("aria-hidden") === "true") return "aria-hidden";
		if (current.hidden) return "hidden-attribute";
	}
	if (
		typeof element.getClientRects === "function" &&
		element.getClientRects().length > 0
	) {
		return null;
	}
	if (
		element.offsetParent !== null ||
		element.offsetWidth > 0 ||
		element.offsetHeight > 0
	) {
		return null;
	}
	return "not-visible";
}

function getTweetContext(element, text, index) {
	const article = element.closest('article[data-testid="tweet"]');
	return {
		index: index + 1,
		chars: text.length,
		preview: previewText(text),
		author: previewText(
			article?.querySelector('[data-testid="User-Name"]')?.innerText || "",
			80,
		),
		statusUrl: article?.querySelector('a[href*="/status/"]')?.href || "",
	};
}

function logRefreshDiagnostics(diagnostics, changed) {
	const accepted = diagnostics.filter((entry) => entry.accepted);
	const skipped = diagnostics.filter((entry) => !entry.accepted);
	console.log(
		`[Pocket Speechify] Twitter extractor refresh triggered: candidates=${diagnostics.length}, accepted=${accepted.length}, skipped=${skipped.length}, changed=${changed}`,
	);

	accepted.forEach((entry, index) => {
		console.log(
			`[Pocket Speechify] Twitter tweet detected #${index + 1}: candidate=${entry.index}, chars=${entry.chars}, words=${entry.words}, sentences=${entry.sentences}, author="${entry.author}", url="${entry.statusUrl}", text="${entry.preview}"`,
		);
	});

	skipped.forEach((entry) => {
		console.log(
			`[Pocket Speechify] Twitter tweet skipped: candidate=${entry.index}, reason=${entry.reason}, chars=${entry.chars}, author="${entry.author}", url="${entry.statusUrl}", text="${entry.preview}"`,
		);
	});
}

function previewText(text, maxLength = 160) {
	const normalized = String(text || "")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1)}…`;
}

function paragraphSignature(paragraphs) {
	return paragraphs.map((paragraph) => paragraph.text).join("\n---\n");
}
