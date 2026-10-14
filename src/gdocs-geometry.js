// On-screen geometry for Google Docs paragraphs. Docs paints text to <canvas>
// and, in annotated-canvas mode, mirrors each rendered line or style run as an
// invisible SVG <rect aria-label="text" data-font-css="font">. Paragraph and
// word offsets are Docs model offsets; this maps them onto those rects.
// Only nearby pages are rendered, so a paragraph may have no geometry; locate()
// then estimates its position so callers can scroll it into view.

const TILE_SELECTOR = ".kix-canvas-tile-content";
const SCROLLER_SELECTOR = ".kix-appview-editor";
const ESTIMATED_LINE_HEIGHT = 20;
// Consecutive groups usually map to consecutive paragraphs; skip at most a few
// unlisted ones (blank or image-only paragraphs, headers) before a full search.
const LOOKAHEAD = 4;

function labelOf(rect) {
	return rect.getAttribute("aria-label") || "";
}

/**
 * Match a group's rects against `text` from `from`. Rects that do not continue
 * the text (list markers such as "●" or "1.") are skipped. With `anywhere`,
 * the first hit may start mid-text at a word boundary: a paragraph continued
 * from the previous page.
 */
function matchGroup(rects, text, from, anywhere) {
	const hits = [];
	let cursor = from;
	for (const rect of rects) {
		const label = labelOf(rect);
		if (!label.trim()) continue;
		let at = text.indexOf(label, cursor);
		if (anywhere && hits.length === 0) {
			while (at > 0 && /\S/.test(text[at - 1])) at = text.indexOf(label, at + 1);
		} else if (at >= 0 && text.slice(cursor, at).trim()) {
			at = -1;
		}
		if (at < 0) continue;
		hits.push({ rect, label, at });
		cursor = at + label.length;
	}
	return hits.length * 2 >= rects.length ? { hits, end: cursor } : null;
}

function union(boxes) {
	const left = Math.min(...boxes.map(box => box.left));
	const right = Math.max(...boxes.map(box => box.right));
	const top = Math.min(...boxes.map(box => box.top));
	const bottom = Math.max(...boxes.map(box => box.bottom));
	return { left, right, top, bottom, width: right - left, height: bottom - top };
}

export function createGoogleDocsGeometry(paragraphs, doc = document) {
	const context = doc.createElement("canvas").getContext("2d");
	const listeners = new Set();
	let mapping = null;
	let observed = null;
	const observer = new MutationObserver(mutations => {
		if (mutations.some(mutation => mutation.target.closest?.("svg") ||
			[...mutation.addedNodes, ...mutation.removedNodes].some(node =>
				node.nodeName === "svg" || node.nodeName === "g" || node.querySelector?.("svg")))) invalidate();
	});

	function scroller() {
		return doc.querySelector(SCROLLER_SELECTOR);
	}

	function invalidate() {
		mapping = null;
		listeners.forEach(listener => listener());
	}

	function textGroups() {
		return [...doc.querySelectorAll(TILE_SELECTOR)]
			.filter(tile => tile.querySelector("g[role=paragraph]"))
			.map(tile => ({ tile, top: tile.getBoundingClientRect().top }))
			.sort((a, b) => a.top - b.top)
			.flatMap(({ tile }) => [...tile.querySelectorAll("svg g[role=paragraph]")])
			// Headers and footers repeat on every page and are not in the body text.
			.filter(group => (group.getAttribute("data-section-type") ?? "body") === "body")
			.map(group => [...group.querySelectorAll("rect[aria-label]")])
			.filter(rects => rects.length > 0);
	}

	// First visible group, or lost track: search every paragraph. Repeated text
	// is resolved by whether the next group continues the candidate, then by
	// distance from where the group is expected.
	function searchAll(rects, nextRects, expectedOffset) {
		let best = null;
		paragraphs.forEach((paragraph, index) => {
			const match = matchGroup(rects, paragraph.text, 0, true);
			if (!match) return;
			const continues = !nextRects ||
				(match.end < paragraph.text.length
					? matchGroup(nextRects, paragraph.text, match.end, false)
					: paragraphs[index + 1] && matchGroup(nextRects, paragraphs[index + 1].text, 0, false));
			const score = (continues ? 0 : 1e12) + Math.abs(paragraph.startOffset + match.hits[0].at - expectedOffset);
			if (!best || score < best.score) best = { match, index, score };
		});
		return best;
	}

	function ensureMapping() {
		if (mapping) return mapping;
		const container = scroller();
		if (container && observed !== container) {
			observer.disconnect();
			observer.observe(container, { childList: true, subtree: true, attributes: true, characterData: true });
			observed = container;
		}
		const totalLength = paragraphs.at(-1)?.endOffset || 1;
		const runs = [];
		const groups = [];
		let index = -1;
		let cursor = 0;
		const allGroups = textGroups();
		allGroups.forEach((rects, groupIndex) => {
			let found = null;
			if (index >= 0 && cursor < paragraphs[index].text.length) {
				const match = matchGroup(rects, paragraphs[index].text, cursor, false);
				if (match) found = { match, index };
			}
			for (let next = index + 1; !found && index >= 0 && next <= index + LOOKAHEAD && next < paragraphs.length; next++) {
				const match = matchGroup(rects, paragraphs[next].text, 0, false);
				if (match) found = { match, index: next };
			}
			if (!found) {
				const expected = index >= 0
					? paragraphs[index].endOffset
					: totalLength * (container ? container.scrollTop / Math.max(1, container.scrollHeight) : 0);
				found = searchAll(rects, allGroups[groupIndex + 1], expected);
			}
			if (!found) return;
			({ index } = found);
			cursor = found.match.end;
			const start = paragraphs[index].startOffset;
			groups.push({ index, rects });
			for (const hit of found.match.hits) {
				runs.push({ index, rect: hit.rect, label: hit.label, start: start + hit.at, end: start + hit.at + hit.label.length });
			}
		});
		mapping = { runs, groups };
		return mapping;
	}

	/** Viewport boxes covering model offsets [start, end) of a rendered paragraph. */
	function rangeRects(paragraphIndex, start, end) {
		const boxes = [];
		for (const run of ensureMapping().runs) {
			if (run.index !== paragraphIndex || run.end <= start || run.start >= end) continue;
			const box = run.rect.getBoundingClientRect();
			const width = parseFloat(run.rect.getAttribute("width"));
			const scale = width > 0 ? box.width / width : 1;
			context.font = run.rect.getAttribute("data-font-css") || "";
			const measure = offset => context.measureText(run.label.slice(0, offset - run.start)).width * scale;
			const left = box.left + measure(Math.max(start, run.start));
			const right = box.left + measure(Math.min(end, run.end));
			boxes.push({ left, right, top: box.top, bottom: box.bottom, width: right - left, height: box.height });
		}
		return boxes;
	}

	function viewport() {
		const container = scroller();
		if (container) return container.getBoundingClientRect();
		return { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
	}

	/**
	 * First box of the range, or a box estimated from rendered paragraphs when
	 * it is off-screen. Null without any annotated geometry (view-only docs).
	 */
	function locate(paragraphIndex, start, end) {
		const rendered = rangeRects(paragraphIndex, start, end)[0];
		if (rendered) return rendered;
		const container = scroller();
		const { runs } = ensureMapping();
		if (!container || runs.length === 0) return null;
		const view = container.getBoundingClientRect();
		const anchors = runs.map(run => ({
			offset: run.start,
			y: run.rect.getBoundingClientRect().top - view.top + container.scrollTop,
		}));
		const first = anchors[0];
		const last = anchors.at(-1);
		const pxPerChar = last.offset > first.offset
			? (last.y - first.y) / (last.offset - first.offset)
			: container.scrollHeight / (paragraphs.at(-1)?.endOffset || 1);
		const nearest = anchors.reduce((a, b) => Math.abs(b.offset - start) < Math.abs(a.offset - start) ? b : a);
		const y = Math.min(Math.max(nearest.y + (start - nearest.offset) * pxPerChar, 0), container.scrollHeight);
		const top = view.top + y - container.scrollTop;
		return {
			left: view.left, right: view.right, width: view.width,
			top, bottom: top + ESTIMATED_LINE_HEIGHT, height: ESTIMATED_LINE_HEIGHT, estimated: true,
		};
	}

	/** Rendered paragraph part under a viewport point, with its first line box. */
	function paragraphAt(x, y) {
		for (const { index, rects } of ensureMapping().groups) {
			const boxes = rects.map(rect => rect.getBoundingClientRect());
			const box = union(boxes);
			if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
				return { index, rect: { ...box, top: boxes[0].top } };
			}
		}
		return null;
	}

	return {
		rangeRects,
		locate,
		paragraphAt,
		viewport,
		scroller,
		invalidate,
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		destroy() {
			observer.disconnect();
			listeners.clear();
		},
	};
}
