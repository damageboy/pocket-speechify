import { describe, it, expect, beforeEach } from "vitest";
import { detectReadableArticle } from "../src/article-detector.js";
import { extractContent } from "../src/content-extractor.js";

// In happy-dom, node.offsetParent is always null, which causes the extractor
// to reject all elements. Match the content-extractor tests by patching it.
function makeOffsetParentNonNull(el) {
	Object.defineProperty(el, "offsetParent", {
		get: () => document.body,
		configurable: true,
	});
}

function setPageHtml({ head = "", body = "" }) {
	document.head.innerHTML = head;
	document.body.innerHTML = body;
	document.body
		.querySelectorAll("*")
		.forEach((el) => makeOffsetParentNonNull(el));
}

function detectPage() {
	const paragraphs = extractContent();
	return detectReadableArticle(document, paragraphs, { isVisible: () => true });
}

function proseParagraph(wordCount, prefix = "Article") {
	const words = Array.from(
		{ length: wordCount },
		(_, index) => `${prefix.toLowerCase()}${index + 1}`,
	);
	return `${prefix} insight. ${words.join(" ")}.`;
}

beforeEach(() => {
	document.head.innerHTML = "";
	document.body.innerHTML = "";
});

describe("detectReadableArticle", () => {
	it("auto-shows an article page with og:type metadata and three long paragraphs", () => {
		setPageHtml({
			head: '<meta property="og:type" content="article">',
			body: `
        <article>
          <p>${proseParagraph(110, "First")}</p>
          <p>${proseParagraph(110, "Second")}</p>
          <p>${proseParagraph(110, "Third")}</p>
        </article>
      `,
		});

		const result = detectPage();

		expect(result.isReadableArticle).toBe(true);
		expect(result.canPlayBestEffort).toBe(true);
		expect(result.confidence).toBeGreaterThanOrEqual(0.65);
		expect(result.proseParagraphIndexes).toHaveLength(3);
	});

	it("rejects a link-heavy homepage/card grid made of LI links", () => {
		setPageHtml({
			body: `
        <main>
          <ul>
            ${Array.from(
							{ length: 8 },
							(_, index) => `
              <li><a href="/story-${index}">${proseParagraph(24, `Card${index}`)}</a></li>
            `,
						).join("")}
          </ul>
        </main>
      `,
		});

		const result = detectPage();

		expect(result.isReadableArticle).toBe(false);
		expect(result.canPlayBestEffort).toBe(false);
		expect(result.proseParagraphIndexes).toHaveLength(0);
	});

	it("rejects a short page", () => {
		setPageHtml({
			body: `
        <main>
          <p>This is a concise summary with too little prose to read automatically.</p>
          <p>Another brief note is present, but the content is still too short.</p>
        </main>
      `,
		});

		const result = detectPage();

		expect(result.isReadableArticle).toBe(false);
		expect(result.canPlayBestEffort).toBe(false);
	});

	it("counts prose-like headings with sentence punctuation before the final character", () => {
		setPageHtml({
			body: `
        <article>
          <h1>This substantial heading asks why? readers should continue today</h1>
          <p>${proseParagraph(80, "First")}</p>
          <p>${proseParagraph(80, "Second")}</p>
        </article>
      `,
		});

		const result = detectPage();

		expect(result.canPlayBestEffort).toBe(true);
		expect(result.proseParagraphIndexes).toContain(0);
	});

	it("auto-shows strong body-only prose without metadata", () => {
		setPageHtml({
			body: `
        <p>${proseParagraph(210, "Alpha")}</p>
        <p>${proseParagraph(210, "Beta")}</p>
        <p>${proseParagraph(210, "Gamma")}</p>
      `,
		});

		const result = detectPage();

		expect(result.isReadableArticle).toBe(true);
		expect(result.canPlayBestEffort).toBe(true);
		expect(result.confidence).toBeGreaterThanOrEqual(0.65);
	});

	it("allows best-effort playback for enough prose with weak article confidence", () => {
		setPageHtml({
			body: `
        <main>
          <p>${proseParagraph(80, "Enough")}</p>
          <p>${proseParagraph(80, "Prose")}</p>
        </main>
      `,
		});

		const result = detectPage();

		expect(result.isReadableArticle).toBe(false);
		expect(result.canPlayBestEffort).toBe(true);
		expect(result.confidence).toBeLessThan(0.65);
	});

	it("ignores hidden itemtype article metadata for auto-show confidence", () => {
		setPageHtml({
			body: `
        <p>${proseParagraph(110, "Alpha")}</p>
        <p>${proseParagraph(110, "Beta")}</p>
        <p>${proseParagraph(110, "Gamma")}</p>
        <div aria-hidden="true" itemtype="https://schema.org/Article"></div>
      `,
		});

		const result = detectPage();

		expect(result.isReadableArticle).toBe(false);
		expect(result.canPlayBestEffort).toBe(true);
		expect(result.confidence).toBeLessThan(0.65);
		expect(result.reason).toContain("metadata=no");
	});

	it("recognizes JSON-LD NewsArticle metadata", () => {
		setPageHtml({
			head: `
        <script type="application/ld+json">
          { "@context": "https://schema.org", "@type": "NewsArticle", "headline": "Readable story" }
        </script>
      `,
			body: `
        <article>
          <p>${proseParagraph(105, "News")}</p>
          <p>${proseParagraph(105, "Report")}</p>
          <p>${proseParagraph(105, "Context")}</p>
        </article>
      `,
		});

		const result = detectPage();

		expect(result.isReadableArticle).toBe(true);
		expect(result.canPlayBestEffort).toBe(true);
		expect(result.confidence).toBeGreaterThanOrEqual(0.65);
	});
});
