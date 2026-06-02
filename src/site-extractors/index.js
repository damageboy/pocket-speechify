import { createTwitterContentSource, matchesTwitterUrl } from "./twitter.js";

const SITE_EXTRACTORS = [
	{
		name: "twitter",
		matches: matchesTwitterUrl,
		createContentSource: createTwitterContentSource,
	},
];

export function getSiteExtractor(url) {
	return SITE_EXTRACTORS.find((extractor) => extractor.matches(url)) || null;
}
