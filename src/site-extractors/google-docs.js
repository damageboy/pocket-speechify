import { buildParagraph, replaceParagraphs } from "../content-paragraphs.js";
import { createGoogleDocsGeometry } from "../gdocs-geometry.js";

const REFRESH_DELAY_MS = 300;
const READY_RETRY_MS = 500;
const READY_TIMEOUT_MS = 15000;
const BRIDGE_TIMEOUT_MS = 2000;

export function matchesGoogleDocsUrl(url) {
	const parsed = typeof url === "string" ? new URL(url) : url;
	return parsed?.hostname === "docs.google.com" && parsed.pathname.startsWith("/document/");
}

/**
 * Split Docs model text into paragraphs whose word offsets are model offsets.
 * Control characters (document start, table/cell markers, soft line breaks),
 * private-use markers (U+EFFF before table-of-contents entries) and
 * inline-object placeholders ("*") become spaces, preserving offsets.
 */
export function parseGoogleDocsText(text, inlineObjects = []) {
	// UTF-16 indices throughout: Docs offsets and JS string offsets agree.
	let clean = String(text || "").replace(/[\u0000-\u0009\u000b-\u001f\ue000-\uf8ff]/g, " ");
	for (const { range } of inlineObjects) {
		clean = clean.slice(0, range.start) + " ".repeat(Math.max(0, range.end - range.start)) + clean.slice(range.end);
	}
	const occurrences = new Map();
	const paragraphs = [];
	let lineStart = 0;
	for (const line of clean.split("\n")) {
		const paragraph = buildParagraph(null, line, "google-docs", lineStart);
		lineStart += line.length + 1;
		if (!paragraph) continue;
		// Offsets shift when text is edited above; identical text keeps its rank.
		const rank = occurrences.get(paragraph.text) || 0;
		occurrences.set(paragraph.text, rank + 1);
		paragraph.identity = `gdocs:${rank}:${paragraph.text}`;
		paragraph.textNodes = [];
		paragraphs.push(paragraph);
	}
	return paragraphs;
}

function createBridgeClient(win) {
	let nextId = 0;
	const pending = new Map();
	win.addEventListener("message", event => {
		if (event.source !== win || event.data?.source !== "pocket-speechify-gdocs") return;
		pending.get(event.data.id)?.(event.data.result);
		pending.delete(event.data.id);
	});
	return function requestDocument() {
		const id = ++nextId;
		return new Promise(resolve => {
			pending.set(id, resolve);
			win.postMessage({ source: "pocket-speechify-content", id, type: "gdocs-get-document" }, win.location.origin);
			setTimeout(() => {
				if (pending.delete(id)) resolve(null);
			}, BRIDGE_TIMEOUT_MS);
		});
	};
}

export function createGoogleDocsContentSource(doc = document, _url, {
	requestDocument = createBridgeClient(doc.defaultView),
} = {}) {
	const listeners = new Set();
	const paragraphs = [];
	const metadata = { hasPlayableContent: false, autoShow: false, dynamic: true, playbackMode: "continuous" };
	const geometry = createGoogleDocsGeometry(paragraphs, doc);
	let cursorOffset = 0;
	let refreshTimer = null;
	let destroyed = false;

	async function refresh({ notifyOnChange = true } = {}) {
		const result = await requestDocument();
		if (destroyed || !result || typeof result.text !== "string") return paragraphs;
		cursorOffset = result.selection?.[0]?.start ?? cursorOffset;
		const previous = paragraphs.slice();
		replaceParagraphs(paragraphs, parseGoogleDocsText(result.text, result.inlineObjects));
		const changed = previous.length !== paragraphs.length ||
			previous.some((paragraph, index) => paragraph !== paragraphs[index]);
		metadata.hasPlayableContent = paragraphs.length > 0;
		metadata.autoShow = paragraphs.length > 0;
		if (changed) {
			console.log(`[Pocket Speechify] Google Docs refresh triggered: paragraphs=${paragraphs.length}`);
			geometry.invalidate();
			if (notifyOnChange) listeners.forEach(listener => listener({ paragraphs, metadata }));
		}
		return paragraphs;
	}

	// The bridge answers once Docs has booted its editor model.
	const ready = (async () => {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (!destroyed && Date.now() < deadline) {
			await refresh({ notifyOnChange: false });
			if (paragraphs.length) return;
			await new Promise(resolve => setTimeout(resolve, READY_RETRY_MS));
		}
		console.warn("[Pocket Speechify] Google Docs text unavailable");
	})();

	// Edits re-render the annotated SVG; scrolling recycles it. Both are cheap to
	// re-read, and unchanged text keeps paragraph identities.
	const unsubscribeGeometry = geometry.onChange(() => {
		if (refreshTimer !== null) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			refresh();
		}, REFRESH_DELAY_MS);
	});

	return {
		site: "google-docs",
		metadata,
		geometry,
		ready,
		getParagraphs() { return paragraphs; },
		/** Paragraph at or after the Docs cursor, where pill playback starts. */
		getStartParagraph() {
			const index = paragraphs.findIndex(paragraph => paragraph.endOffset >= cursorOffset);
			return index < 0 ? 0 : index;
		},
		refresh,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		destroy() {
			destroyed = true;
			clearTimeout(refreshTimer);
			unsubscribeGeometry();
			geometry.destroy();
			listeners.clear();
		},
	};
}
