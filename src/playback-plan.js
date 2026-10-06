export const PLAYBACK_MODE_CONTINUOUS = "continuous";
export const PLAYBACK_MODE_SINGLE = "single";

// Never map old audio onto edited text or another fragment of the same element.
export function findParagraphIndex(paragraphs, target) {
	if (!target) return -1;
	return paragraphs.findIndex(paragraph => paragraph === target ||
		(paragraph.text === target.text && (target.twitterIdentity
			? paragraph.twitterIdentity === target.twitterIdentity
			: target.element && paragraph.element === target.element &&
				paragraph.startOffset === target.startOffset)));
}

export function createPlaybackPlan({
	paragraphs,
	fromParagraph = 0,
	playbackMode = PLAYBACK_MODE_CONTINUOUS,
}) {
	if (playbackMode === PLAYBACK_MODE_SINGLE) {
		return {
			playbackMode,
			ttsParagraphs: paragraphs[fromParagraph]
				? [paragraphs[fromParagraph]]
				: [],
			ttsStartParagraph: 0,
			sourceParagraphs: paragraphs,
		};
	}

	return {
		playbackMode: PLAYBACK_MODE_CONTINUOUS,
		ttsParagraphs: paragraphs.slice(),
		ttsStartParagraph: fromParagraph,
		sourceParagraphs: paragraphs,
	};
}

/** Current index in the (live) source paragraphs, or null if it is gone. */
export function toGlobalParagraphIndex(playbackPlan, ttsParagraphIndex) {
	const index = findParagraphIndex(
		playbackPlan.sourceParagraphs, playbackPlan.ttsParagraphs[ttsParagraphIndex],
	);
	return index === -1 ? null : index;
}

export function canMoveToParagraph(playbackPlan, targetParagraphIndex) {
	if (playbackPlan.playbackMode !== PLAYBACK_MODE_SINGLE) return true;
	return targetParagraphIndex === toGlobalParagraphIndex(playbackPlan, 0);
}
