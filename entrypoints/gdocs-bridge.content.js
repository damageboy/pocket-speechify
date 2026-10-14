// Runs in the Google Docs page's own JS context before Docs boots. Docs renders
// text to <canvas>; any non-empty requester name makes it also emit invisible
// SVG text rects (geometry) and exposes its annotated-text model API. The
// isolated content script cannot see page globals, so this relays requests.
const REQUESTER = "pocket-speechify";

export default defineContentScript({
	matches: ["https://docs.google.com/document/*"],
	runAt: "document_start",
	world: "MAIN",
	main() {
		window._docs_annotate_canvas_by_ext = REQUESTER;
		let warned = false;
		window.addEventListener("message", async (event) => {
			if (event.source !== window || event.data?.source !== "pocket-speechify-content") return;
			const { id, type } = event.data;
			let result = null;
			try {
				// Resolves once the editor has booted.
				const api = await window._docs_annotate_getAnnotatedText?.(REQUESTER);
				if (api && type === "gdocs-get-document") {
					result = {
						text: api.getText(),
						selection: api.getSelection(),
						inlineObjects: api.getAnnotations()?.inlineObject || [],
					};
				}
			} catch (error) {
				if (!warned) console.warn("[Pocket Speechify] Google Docs annotated text unavailable:", error);
				warned = true;
			}
			window.postMessage({ source: "pocket-speechify-gdocs", id, result }, location.origin);
		});
	},
});
