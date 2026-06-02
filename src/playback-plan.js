export const PLAYBACK_MODE_CONTINUOUS = "continuous";
export const PLAYBACK_MODE_SINGLE = "single";

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
			paragraphIndexOffset: fromParagraph,
		};
	}

	return {
		playbackMode: PLAYBACK_MODE_CONTINUOUS,
		ttsParagraphs: paragraphs,
		ttsStartParagraph: fromParagraph,
		paragraphIndexOffset: 0,
	};
}

export function toGlobalParagraphIndex(playbackPlan, ttsParagraphIndex) {
	return ttsParagraphIndex + playbackPlan.paragraphIndexOffset;
}

export function canMoveToParagraph(playbackPlan, targetParagraphIndex) {
	if (playbackPlan.playbackMode !== PLAYBACK_MODE_SINGLE) return true;
	return targetParagraphIndex === playbackPlan.paragraphIndexOffset;
}
