import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleDocsContentSource, parseGoogleDocsText } from "../src/site-extractors/google-docs.js";
import { createGoogleDocsGeometry } from "../src/gdocs-geometry.js";
import { findParagraphIndex } from "../src/playback-plan.js";

// Shape of real Docs model text: document start (\u0003), soft line break
// (\u000b), table/row/cell markers (\u0010 \u0012 \u001c \u0011), and an inline
// image placeholder "*" reported through inlineObject annotations, and the
// private-use marker that starts table-of-contents entries.
const MODEL = "\u0003Title 😀 here\n\uefffContents entry\nFirst line\u000bsoft break.\n\n*\n\u0010\u0012\u001cCell one\n\u001cCell two\n\u0011After table.\n";

describe("parseGoogleDocsText", () => {
	it("keeps word offsets equal to Docs model offsets", () => {
		const image = MODEL.indexOf("*");
		const paragraphs = parseGoogleDocsText(MODEL, [{ range: { start: image, end: image + 1 } }]);
		expect(paragraphs.map(p => p.text)).toEqual([
			"Title 😀 here", "Contents entry", "First line soft break.", "Cell one", "Cell two", "After table.",
		]);
		for (const paragraph of paragraphs) {
			expect(MODEL.slice(paragraph.startOffset, paragraph.endOffset).replace("\u000b", " ")).toBe(paragraph.text);
			for (const word of paragraph.words) {
				expect(MODEL.slice(word.startOffset, word.endOffset)).toBe(word.text);
			}
		}
	});
});

describe("Google Docs content source", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		document.body.replaceChildren();
	});

	it("starts at the cursor paragraph and keeps identities when text is inserted above", async () => {
		let response = { text: "\u0003Alpha one.\n\nBeta two.\nAlpha one.\n", selection: [{ start: 12, end: 12 }] };
		const source = createGoogleDocsContentSource(document, null, { requestDocument: async () => response });
		await source.ready;
		const paragraphs = source.getParagraphs();
		expect(paragraphs.map(p => p.text)).toEqual(["Alpha one.", "Beta two.", "Alpha one."]);
		// Cursor on the blank line before "Beta two." starts there, not at the top.
		expect(source.getStartParagraph()).toBe(1);

		const repeated = paragraphs[2];
		const changed = vi.fn();
		source.subscribe(changed);
		response = { text: "\u0003Inserted.\nAlpha one.\n\nBeta two.\nAlpha one.\n", selection: [] };
		await source.refresh();
		expect(changed).toHaveBeenCalledTimes(1);
		// Offsets shifted, but the second "Alpha one." is still found as itself.
		expect(findParagraphIndex(paragraphs, repeated)).toBe(3);
		source.destroy();
	});
});

describe("createGoogleDocsGeometry", () => {
	const CHAR_WIDTH = 10;
	beforeEach(() => {
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			font: "", measureText: text => ({ width: text.length * CHAR_WIDTH }),
		});
		// Boxes come from data-box="left,top,width,height" (viewport pixels).
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
			const [left, top, width, height] = (this.getAttribute("data-box") || "0,0,0,0").split(",").map(Number);
			return { left, top, width, height, right: left + width, bottom: top + height };
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.replaceChildren();
	});

	const rect = (label, box, width = box.split(",")[2]) =>
		`<rect aria-label="${label}" width="${width}" data-box="${box}" data-font-css="400 14px Arial"></rect>`;
	const group = (rects, section = "body") => `<g role="paragraph" data-section-type="${section}">${rects}</g>`;
	const tile = (box, groups) =>
		`<div class="kix-canvas-tile-content" data-box="${box}"><svg>${groups.join("")}</svg></div>`;

	it("maps rendered rects onto model paragraphs across markers, page splits and recycled tiles", () => {
		const paragraphs = parseGoogleDocsText("\u0003Same text.\nSame text.\nItem one.\nSplit across two pages.\n");
		// Page 2 is first in the DOM (recycled tile). Page 1 has a header whose
		// text also occurs in the body, the second "Same text." (the first is on
		// an unrendered page), a list item with a marker, and the start of a
		// paragraph that continues on page 2.
		document.body.innerHTML = `<div class="kix-appview-editor">
			${tile("0,1000,800,1000", [group(rect("two pages.", "100,1100,100,20"))])}
			${tile("0,0,800,1000", [
				group(rect("Item one.", "100,40,90,20"), "header"),
				group(rect("Same text.", "100,100,100,20")),
				group(rect("●", "80,130,8,20") + rect("Item one.", "100,130,90,20")),
				group(rect("Split across", "100,160,240,20", 120)),
			])}
		</div>`;
		const geometry = createGoogleDocsGeometry(paragraphs, document);

		expect(geometry.rangeRects(0, paragraphs[0].startOffset, paragraphs[0].endOffset)).toEqual([]);
		expect(geometry.rangeRects(1, paragraphs[1].startOffset, paragraphs[1].endOffset)).toHaveLength(1);
		expect(geometry.rangeRects(2, paragraphs[2].startOffset, paragraphs[2].endOffset)).toEqual([
			expect.objectContaining({ top: 130 }),
		]);
		// "across" is chars 6..12 of a run drawn at 2x (240px box, width attr 120).
		const across = paragraphs[3].words[1];
		expect(geometry.rangeRects(3, across.startOffset, across.endOffset)).toEqual([
			expect.objectContaining({ left: 100 + 6 * CHAR_WIDTH * 2, width: 6 * CHAR_WIDTH * 2, top: 160 }),
		]);
		// "pages." continues on page 2 at offset 4 of the "two pages." run.
		const pages = paragraphs[3].words.at(-1);
		expect(geometry.rangeRects(3, pages.startOffset, pages.endOffset)).toEqual([
			expect.objectContaining({ left: 100 + 4 * CHAR_WIDTH, top: 1100 }),
		]);
		// Hovering the list item's marker hits the item, positioned from the marker.
		expect(geometry.paragraphAt(84, 140)).toEqual({ index: 2, rect: expect.objectContaining({ left: 80, top: 130 }) });
		geometry.destroy();
	});
});
