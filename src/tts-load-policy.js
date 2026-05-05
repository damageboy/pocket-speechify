export function getTTSLoadPlan({
	hasWorker,
	currentLoadedLanguage,
	currentLoadedVoiceId,
	language,
	voiceId,
}) {
	const loadModel = !hasWorker || currentLoadedLanguage !== language;
	const loadVoice = loadModel || currentLoadedVoiceId !== voiceId;
	return { loadModel, loadVoice };
}
