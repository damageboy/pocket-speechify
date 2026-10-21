// Detection harness: load a saved scrape, run the extension's real paragraph
// extraction and article detection on it, and outline every detected
// paragraph so the results can be validated visually. Imports the same
// modules the content script uses; nothing here is stubbed.
import { createContentSource } from "../src/content-extractor.js";
import { detectReadableArticle } from "../src/article-detector.js";

const picker = document.getElementById("scrape-picker");
const executeScripts = document.getElementById("execute-scripts");
const detectButton = document.getElementById("detect-button");
const copyButton = document.getElementById("copy-report");
const summary = document.getElementById("summary");
const legend = document.getElementById("legend");
const list = document.getElementById("paragraph-list");
const frame = document.getElementById("frame");

const OVERLAY_STYLE = `
	.psh-detected { outline: 2px solid rgba(35, 174, 117, 0.85); outline-offset: 1px; }
	.psh-detected[data-psh-prose="0"] { outline-color: rgba(230, 134, 0, 0.85); }
	.psh-detected::after {
		content: attr(data-psh-index);
		position: absolute; left: 0; top: 0; transform: translateY(-55%);
		z-index: 2147483644; padding: 0 5px; border-radius: 4px;
		background: #23ae75; color: #fff; font: 700 10px/1.6 monospace;
	}
	.psh-detected[data-psh-prose="0"]::after { background: #e68600; }
	.psh-detected.psh-flash {
		outline-color: #5666f0 !important;
		box-shadow: 0 0 0 4px rgba(86, 102, 240, 0.35);
		background-color: rgba(86, 102, 240, 0.12);
	}
`;

const params = new URLSearchParams(location.search);
let records = [];
let lastReport = null;

initPicker();

async function initPicker() {
	let scrapes = [];
	try {
		scrapes = (await fetch("/api/scrapes").then((r) => r.json())).scrapes;
	} catch (error) {
		console.error("[Pocket Speechify harness] Could not list scrapes:", error);
	}
	picker.innerHTML = "";
	if (scrapes.length === 0) {
		picker.append(new Option("No scrapes found under web-page-scrapes/", ""));
	} else {
		picker.append(new Option("Pick a saved scrape…", ""));
		for (const scrape of scrapes) picker.append(new Option(scrape, scrape));
	}
	const current = params.get("page");
	if (current) {
		picker.value = current;
		if (picker.value === current) {
			detectButton.disabled = false;
			loadScrape();
		} else picker.value = "";
	}
	console.log(`[Pocket Speechify harness] Picker loaded: ${scrapes.length} scrape(s)`);
}

picker.addEventListener("change", () => {
	console.log(`[Pocket Speechify harness] Scrape selected: ${picker.value || "(none)"}`);
	const url = new URL(location.href);
	if (picker.value) url.searchParams.set("page", picker.value);
	else url.searchParams.delete("page");
	history.replaceState(null, "", url);
	detectButton.disabled = !picker.value;
	if (picker.value) loadScrape();
});

executeScripts.addEventListener("change", () => {
	console.log(`[Pocket Speechify harness] Page scripts toggled: ${executeScripts.checked ? "on" : "off"}`);
	if (picker.value) loadScrape();
});

detectButton.addEventListener("click", () => {
	console.log("[Pocket Speechify harness] Run detection clicked");
	if (picker.value) loadScrape();
});

copyButton.addEventListener("click", async () => {
	console.log("[Pocket Speechify harness] Copy JSON report clicked");
	if (!lastReport) return;
	try {
		await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2));
		copyButton.textContent = "Copied!";
		setTimeout(() => { copyButton.textContent = "Copy JSON report"; }, 1200);
	} catch (error) {
		console.error("[Pocket Speechify harness] Clipboard failed:", error);
	}
});

async function loadScrape() {
	const page = picker.value;
	console.log(`[Pocket Speechify harness] Loading scrape: ${page} (scripts ${executeScripts.checked ? "enabled" : "stripped"})`);
	records = [];
	lastReport = null;
	copyButton.disabled = true;
	list.innerHTML = "";
	legend.hidden = true;
	summary.querySelector("#empty")?.remove();
	summary.innerHTML = "<div>Loading…</div>";
	// ?page= is repo-root-relative; the server serves the repo root.
	const pageUrl = new URL(`/${page}`, location.href);
	let html;
	try {
		html = await fetch(pageUrl.href).then((r) => {
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return r.text();
		});
	} catch (error) {
		console.error("[Pocket Speechify harness] Fetch failed:", error);
		summary.innerHTML = `<div class="verdict bad">Could not load scrape: ${escapeHtml(String(error))}</div>`;
		return;
	}
	const originalUrl = parseSavedFromUrl(html) || "https://saved-page.invalid/";
	const doc = new DOMParser().parseFromString(html, "text/html");
	if (!executeScripts.checked) doc.querySelectorAll("script").forEach((script) => script.remove());
	const base = doc.createElement("base");
	base.href = pageUrl.href;
	doc.head.prepend(base);
	frame.srcdoc = `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
	frame.addEventListener("load", () => {
		runDetection(frame.contentDocument, originalUrl, page);
	}, { once: true });
}

// Chrome saves "<!-- saved from url=(0066)https://… -->" with the original URL.
function parseSavedFromUrl(html) {
	const match = html.match(/saved from url=\(\d+\)(\S+)/);
	return match ? match[1] : null;
}

function runDetection(doc, originalUrl, page) {
	const started = performance.now();
	// createContentSource mirrors the content script: it picks a site extractor
	// by URL (e.g. twitter) or falls back to the generic one. The source owns a
	// MutationObserver we do not need here, so destroy() right after extracting.
	const source = createContentSource(new URL(originalUrl), doc);
	const paragraphs = source.getParagraphs();
	const detection = detectReadableArticle(doc, paragraphs);
	const metadata = source.metadata || {};
	source.destroy();
	console.log(
		`[Pocket Speechify harness] Detection done: site=${source.site}, paragraphs=${paragraphs.length}, ` +
		`confidence=${detection.confidence}, took ${(performance.now() - started).toFixed(1)}ms`,
	);

	const proseSet = new Set(detection.proseParagraphIndexes || []);
	const playable = Boolean(metadata.hasPlayableContent || detection.isReadableArticle || detection.canPlayBestEffort);
	const autoShow = Boolean(metadata.autoShow || detection.isReadableArticle);

	renderOverlays(doc, paragraphs, proseSet);
	renderList(paragraphs, proseSet, doc);
	renderSummary({ page, originalUrl, source, paragraphs, detection, metadata, playable, autoShow });
	bindFrameClicks(doc);

	lastReport = {
		page,
		originalUrl,
		site: source.site,
		playbackMode: metadata.playbackMode || "continuous",
		playable,
		autoShow,
		detection: {
			isReadableArticle: detection.isReadableArticle,
			canPlayBestEffort: detection.canPlayBestEffort,
			confidence: detection.confidence,
			reason: detection.reason,
		},
		paragraphCount: paragraphs.length,
		totalWords: paragraphs.reduce((sum, p) => sum + p.words.length, 0),
		paragraphs: paragraphs.map((p, index) => ({
			index,
			source: p.source,
			tag: p.element?.tagName || null,
			prose: proseSet.has(index),
			words: p.words.length,
			sentences: p.sentences.length,
			startOffset: p.startOffset,
			endOffset: p.endOffset,
			text: p.text,
		})),
	};
	copyButton.disabled = false;
}

function renderOverlays(doc, paragraphs, proseSet) {
	doc.getElementById("psh-overlay-style")?.remove();
	const style = doc.createElement("style");
	style.id = "psh-overlay-style";
	style.textContent = OVERLAY_STYLE;
	doc.head.appendChild(style);
	for (const [index, paragraph] of paragraphs.entries()) {
		const el = paragraph.element;
		if (!el || !el.isConnected) continue;
		el.classList.add("psh-detected");
		el.setAttribute("data-psh-index", String(index));
		el.setAttribute("data-psh-prose", proseSet.has(index) ? "1" : "0");
		// Anchor the index badge; position changes cannot affect extraction,
		// which only looks at display/visibility.
		if (doc.defaultView.getComputedStyle(el).position === "static") {
			el.style.position = "relative";
		}
		records[index] = el;
	}
}

function renderList(paragraphs, proseSet, doc) {
	list.innerHTML = "";
	legend.hidden = false;
	for (const [index, paragraph] of paragraphs.entries()) {
		const item = document.createElement("li");
		if (!proseSet.has(index)) item.classList.add("non-prose");
		item.dataset.index = String(index);
		item.textContent = paragraph.text.slice(0, 160);
		const meta = document.createElement("div");
		meta.className = "meta";
		meta.textContent = `#${index} · ${paragraph.element?.tagName || "?"} · ${paragraph.source} · ${paragraph.words.length}w · ${paragraph.sentences.length}s`;
		item.prepend(meta);
		const idx = document.createElement("span");
		idx.className = "idx";
		idx.textContent = `#${index} `;
		item.prepend(idx);
		item.addEventListener("mouseenter", () => {
			flash(index, false);
		});
		item.addEventListener("click", () => {
			console.log(`[Pocket Speechify harness] List paragraph #${index} clicked`);
			focusParagraph(index, true);
		});
		list.append(item);
	}
}

function renderSummary({ page, originalUrl, source, paragraphs, detection, playable, autoShow }) {
	const words = paragraphs.reduce((sum, p) => sum + p.words.length, 0);
	summary.innerHTML = `
		<div><strong>${escapeHtml(page)}</strong></div>
		<div>original: <a href="${escapeHtml(originalUrl)}" target="_blank" rel="noreferrer">${escapeHtml(originalUrl)}</a></div>
		<div class="verdict ${playable ? "ok" : "bad"}">${playable ? "✓ playable" : "✗ not playable"} · auto-show ${autoShow ? "on" : "off"}</div>
		<dl>
			<dt>extractor</dt><dd>${escapeHtml(source.site)}</dd>
			<dt>paragraphs</dt><dd>${paragraphs.length}</dd>
			<dt>words</dt><dd>${words}</dd>
			<dt>prose blocks</dt><dd>${(detection.proseParagraphIndexes || []).length}</dd>
			<dt>isReadableArticle</dt><dd>${detection.isReadableArticle}</dd>
			<dt>canPlayBestEffort</dt><dd>${detection.canPlayBestEffort}</dd>
			<dt>confidence</dt><dd>${detection.confidence.toFixed(2)}</dd>
		</dl>
		<div style="color:#9f9f9f">${escapeHtml(detection.reason)}</div>
	`;
}

function bindFrameClicks(doc) {
	doc.addEventListener("click", (event) => {
		const detected = event.target.closest?.(".psh-detected");
		if (!detected) return;
		const index = Number(detected.getAttribute("data-psh-index"));
		console.log(`[Pocket Speechify harness] Page paragraph #${index} clicked`);
		const item = list.querySelector(`li[data-index="${index}"]`);
		if (item) {
			list.querySelectorAll("li.active").forEach((el) => el.classList.remove("active"));
			item.classList.add("active");
			item.scrollIntoView({ block: "nearest" });
		}
	});
}

function focusParagraph(index, scroll) {
	const el = records[index];
	if (!el || !el.isConnected) return;
	if (scroll) el.scrollIntoView({ block: "center" });
	flash(index, true);
}

function flash(index, scroll) {
	const el = records[index];
	if (!el || !el.isConnected) return;
	el.classList.add("psh-flash");
	setTimeout(() => el.classList.remove("psh-flash"), 900);
}

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (ch) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	}[ch]));
}
