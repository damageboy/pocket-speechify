// Static dev server for the scrape detection harness. Serves the repo root so
// pages under web-page-scrapes/ load with their saved assets, and exposes the
// list of saved scrapes at /api/scrapes for the harness picker.
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 8899;

const MIME = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json",
	".txt": "text/plain; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
};

async function listScrapes(dir = path.join(root, "web-page-scrapes"), prefix = "") {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".")) continue;
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...(await listScrapes(path.join(dir, entry.name), rel)));
		else if (entry.name.toLowerCase().endsWith(".html")) files.push(rel);
	}
	return files;
}

createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);
		if (url.pathname === "/api/scrapes") {
			const scrapes = (await listScrapes()).map((rel) => `web-page-scrapes/${rel}`);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ scrapes }));
			return;
		}
		let pathname = decodeURIComponent(url.pathname);
		if (pathname.endsWith("/")) pathname += "index.html";
		const filePath = path.resolve(path.join(root, pathname));
		if (filePath !== root && !filePath.startsWith(root + path.sep)) {
			res.writeHead(403).end("Forbidden");
			return;
		}
		const data = await fs.readFile(filePath);
		res.writeHead(200, {
			"content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
		});
		res.end(data);
	} catch (error) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end(`Not found: ${error?.message || error}`);
	}
}).listen(port, () => {
	console.log(`[scrape server] harness: http://localhost:${port}/dev/scrape-harness.html`);
});
