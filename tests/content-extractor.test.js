import { describe, it, expect, beforeEach } from "vitest";
import { extractContent } from "../src/content-extractor.js";
import { createRangeFromOffsets } from "../src/dom-utils.js";

function setBodyHtml(html) {
	document.body.innerHTML = html;
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("extractContent", () => {
	it("extracts paragraphs from simple <p> tags", () => {
		setBodyHtml("<p>Hello world. This is a test.</p><p>Second paragraph.</p>");
		const paragraphs = extractContent();
		expect(paragraphs.length).toBe(2);
		expect(paragraphs[0].text).toContain("Hello world");
		expect(paragraphs[1].text).toContain("Second paragraph");
	});

	it("each paragraph has element, text, sentences, and words", () => {
		setBodyHtml("<p>Hello world.</p>");
		const paragraphs = extractContent();
		expect(paragraphs.length).toBe(1);
		const p = paragraphs[0];
		expect(p.element).toBeDefined();
		expect(typeof p.text).toBe("string");
		expect(Array.isArray(p.sentences)).toBe(true);
		expect(Array.isArray(p.words)).toBe(true);
	});

	it("returns empty array for empty body", () => {
		document.body.innerHTML = "";
		const paragraphs = extractContent();
		expect(paragraphs).toEqual([]);
	});

	it("skips empty paragraphs", () => {
		setBodyHtml("<p></p><p>   </p><p>Real content.</p>");
		const paragraphs = extractContent();
		expect(paragraphs.length).toBe(1);
		expect(paragraphs[0].text).toContain("Real content");
	});

	it("skips elements with aria-hidden=true", () => {
		setBodyHtml('<p aria-hidden="true">Hidden</p><p>Visible</p>');
		const paragraphs = extractContent();
		expect(paragraphs.length).toBe(1);
		expect(paragraphs[0].text).toBe("Visible");
	});

	it("skips content inside SKIP_TAGS (nav, footer, header, aside, script, style)", () => {
		setBodyHtml(`
      <nav><p>Nav item</p></nav>
      <footer><p>Footer text</p></footer>
      <p>Main content.</p>
    `);
		const paragraphs = extractContent();
		expect(paragraphs.length).toBe(1);
		expect(paragraphs[0].text).toBe("Main content.");
	});

	it("extracts from heading tags (h1-h6)", () => {
		setBodyHtml("<h1>Title here</h1><h2>Subtitle</h2><p>Body text.</p>");
		const paragraphs = extractContent();
		expect(paragraphs.length).toBe(3);
		expect(paragraphs[0].text).toBe("Title here");
		expect(paragraphs[1].text).toBe("Subtitle");
	});

	it("extracts from li and blockquote tags", () => {
		setBodyHtml(
			"<ul><li>Item one</li><li>Item two</li></ul><blockquote>A quote.</blockquote>",
		);
		const paragraphs = extractContent();
		expect(paragraphs.length).toBe(3);
	});

	it("does not duplicate list items that wrap their text in paragraph tags", () => {
		setBodyHtml(
			"<p>There are two camps:</p><ol><li><p>Team price/book</p></li><li><p>Team price/earnings</p></li></ol>",
		);

		const paragraphs = extractContent();

		expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
			"There are two camps:",
			"Team price/book",
			"Team price/earnings",
		]);
	});

	it("splits text into sentences", () => {
		setBodyHtml("<p>First sentence. Second sentence! Third sentence?</p>");
		const paragraphs = extractContent();
		expect(paragraphs.length).toBe(1);
		const sentences = paragraphs[0].sentences;
		expect(sentences.length).toBe(3);
		expect(sentences[0].text).toContain("First sentence");
		expect(sentences[1].text).toContain("Second sentence");
		expect(sentences[2].text).toContain("Third sentence");
	});

	it("single sentence paragraph has one sentence", () => {
		setBodyHtml("<p>Just one sentence here.</p>");
		const paragraphs = extractContent();
		expect(paragraphs[0].sentences.length).toBe(1);
	});

	it("words are split correctly within sentences", () => {
		setBodyHtml("<p>Hello world.</p>");
		const paragraphs = extractContent();
		const words = paragraphs[0].words;
		expect(words.length).toBe(2);
		expect(words[0].text).toBe("Hello");
		expect(words[1].text).toBe("world.");
	});

	it("each word has startOffset and endOffset", () => {
		setBodyHtml("<p>Hello world.</p>");
		const paragraphs = extractContent();
		const words = paragraphs[0].words;
		expect(words[0]).toHaveProperty("startOffset");
		expect(words[0]).toHaveProperty("endOffset");
		expect(typeof words[0].startOffset).toBe("number");
		expect(typeof words[0].endOffset).toBe("number");
	});

	it("words flat list equals all words from all sentences", () => {
		setBodyHtml("<p>One two. Three four.</p>");
		const paragraphs = extractContent();
		const p = paragraphs[0];
		const sentenceWords = p.sentences.flatMap((s) => s.words);
		expect(p.words).toEqual(sentenceWords);
	});

	it("extracts visible paragraph descendants inside layout wrappers with null offsetParent", () => {
		setBodyHtml(
			"<astro-island><article><p>Cloudflare article paragraph should be read.</p></article></astro-island>",
		);
		const wrapper = document.querySelector("astro-island");
		Object.defineProperty(wrapper, "offsetParent", {
			get: () => null,
			configurable: true,
		});

		const paragraphs = extractContent();

		expect(paragraphs.length).toBe(1);
		expect(paragraphs[0].text).toBe(
			"Cloudflare article paragraph should be read.",
		);
	});

	it("returns only block-level content, not generic divs", () => {
		setBodyHtml("<div>Just a div</div><p>A paragraph.</p>");
		const paragraphs = extractContent();
		// div is not in BLOCK_TAGS, only p should be extracted
		expect(paragraphs.length).toBe(1);
		expect(paragraphs[0].text).toBe("A paragraph.");
	});
});

const texts = (paragraphs) => paragraphs.map((paragraph) => paragraph.text);

describe("extractContent nesting and hidden text", () => {
	it("keeps before, nested blocks, and after fragments in DOM order with full-element offsets", () => {
		setBodyHtml("<blockquote>  Before.<div><p>Middle.</p></div> After. </blockquote>");
		const paragraphs = extractContent();
		expect(texts(paragraphs)).toEqual(["Before.", "Middle.", "After."]);
		expect(paragraphs[0].element).toBe(paragraphs[2].element);
		for (const paragraph of paragraphs) {
			expect(createRangeFromOffsets(paragraph.element, paragraph.startOffset, paragraph.endOffset).toString()).toBe(paragraph.text);
			for (const word of paragraph.words) {
				expect(createRangeFromOffsets(paragraph.element, word.startOffset, word.endOffset).toString()).toBe(word.text);
			}
		}
	});

	it("excludes visibility-hidden text but keeps explicitly visible descendants", () => {
		setBodyHtml('<div style="visibility:hidden"><p>Hidden.</p><p style="visibility:visible">Override.</p></div><p>Start <span style="visibility:hidden">gone <b style="visibility:visible">kept</b></span> end.</p>');
		expect(texts(extractContent())).toEqual(["Override.", "Start kept end."]);
	});

	it("keeps fixed paragraphs and display-contents paragraph descendants without offsetParent", () => {
		document.body.innerHTML = '<p style="position:fixed">Fixed.</p><blockquote style="display:contents"><p>Nested.</p></blockquote><div style="display:none"><p>Gone.</p></div>';
		for (const element of document.querySelectorAll("p,blockquote")) {
			Object.defineProperty(element, "offsetParent", { get: () => null, configurable: true });
		}
		expect(texts(extractContent())).toEqual(["Fixed.", "Nested."]);
	});

	it("reads nested paragraph blocks once", () => {
		setBodyHtml(
			"<blockquote><p>First quote.</p><p>Second quote.</p></blockquote>",
		);
		expect(texts(extractContent())).toEqual(["First quote.", "Second quote."]);
	});

	it("does not repeat nested list items in their parent item", () => {
		setBodyHtml(
			"<ul><li>Parent item.<ul><li>Child A.</li><li>Child B.</li></ul></li></ul>",
		);
		expect(texts(extractContent())).toEqual([
			"Parent item.",
			"Child A.",
			"Child B.",
		]);
	});

	it("skips hidden inline text", () => {
		setBodyHtml(
			'<p>Visible text.<span style="display:none">HIDDEN.</span><span aria-hidden="true">ARIA.</span><script>var x;</script></p>',
		);
		expect(texts(extractContent())).toEqual(["Visible text."]);
	});

	it("separates words at <br> and inner block boundaries", () => {
		setBodyHtml("<p>Line one<br>Line two</p><li><div>Cell a</div><div>Cell b</div></li>");
		const [br, divs] = extractContent();
		expect(br.words.map((word) => word.text)).toEqual(["Line", "one", "Line", "two"]);
		expect(divs.words.map((word) => word.text)).toEqual(["Cell", "a", "Cell", "b"]);
	});
});

describe("word offsets map onto the DOM", () => {
	it.each([
		["leading whitespace", "<p>\n      Hello brave world.</p>"],
		["inline markup", "<p>  <b>Bold</b> lead and <i>ta</i>il.</p>"],
		["hidden span and br", '<p> Before <span style="display:none">gone</span>after<br>next line.</p>'],
		["nested block", "<li>  Parent words.<ul><li>Child.</li></ul> tail end.</li>"],
	])("highlights exactly each word with %s", (_, html) => {
		setBodyHtml(html);
		const [paragraph] = extractContent();
		for (const word of paragraph.words) {
			const range = createRangeFromOffsets(
				paragraph.element,
				word.startOffset,
				word.endOffset,
			);
			expect(range.toString()).toBe(word.text);
		}
	});
});

describe("sentence splitting", () => {
	function sentencesOf(text) {
		setBodyHtml(`<p>${text}</p>`);
		return extractContent()[0].sentences.map((sentence) => sentence.text);
	}

	it("does not split after titles, initials, or before lowercase words", () => {
		expect(
			sentencesOf("Dr. Smith met J. K. Rowling in the U.S. on Jan. 5. Pi is 3.14, e.g. a number. Done."),
		).toEqual([
			"Dr. Smith met J. K. Rowling in the U.S. on Jan. 5.",
			"Pi is 3.14, e.g. a number.",
			"Done.",
		]);
	});

	it("splits after closing quotes and ellipses", () => {
		expect(sentencesOf('He said "Hi." Then he left... Ok?! Yes.')).toEqual([
			'He said "Hi."',
			"Then he left...",
			"Ok?!",
			"Yes.",
		]);
	});

	it("keeps sentence words identical to paragraph-level whitespace words", () => {
		setBodyHtml('<p> A "quote." Then (Fig. 2) more… End!</p>');
		const [paragraph] = extractContent();
		expect(paragraph.words.map((word) => word.text)).toEqual(
			paragraph.text.match(/\S+/g),
		);
	});
});
