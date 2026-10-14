import { createTwitterContentSource, matchesTwitterUrl } from "./twitter.js";
import { createGoogleDocsContentSource, matchesGoogleDocsUrl } from "./google-docs.js";

const SITE_EXTRACTORS = [
	{
		name: "google-docs",
		matches: matchesGoogleDocsUrl,
		createContentSource: createGoogleDocsContentSource,
	},
	{
		name: "twitter",
		matches: matchesTwitterUrl,
		createContentSource: createTwitterContentSource,
	},
];

export function getSiteExtractor(url) {
	return SITE_EXTRACTORS.find((extractor) => extractor.matches(url)) || null;
}
