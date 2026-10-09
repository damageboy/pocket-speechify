import { log } from "../src/logger.js";
import { createState } from "../src/state.js";
import { createContentSource } from "../src/content-extractor.js";
import { detectReadableArticle } from "../src/article-detector.js";
import { RemoteTTS } from "../src/remote-tts.js";
import { initPillPlayer } from "../src/pill-player.js";
import { initSidePanels } from "../src/side-panels.js";
import { initHighlights } from "../src/highlight.js";
import { initHoverPlayer } from "../src/hover-player.js";
import { initScrollNav } from "../src/scroll-nav.js";
import {
	canMoveToParagraph,
	createPlaybackPlan,
	findParagraphIndex,
	toGlobalParagraphIndex,
} from "../src/playback-plan.js";
import { resolvePageLanguage } from "../src/language-detection.js";
import { getLanguage, isSupportedLanguage } from "../src/languages.js";
import { normalizeSpeechProfile } from "../src/speech-preferences.js";
import {
	computeProgress,
	createRateMeter,
} from "../src/playback-progress.js";

function wordOffsetForSentence(paragraphs, pIdx, sIdx) {
	return paragraphs[pIdx].sentences
		.slice(0, sIdx)
		.reduce((sum, s) => sum + s.words.length, 0);
}

function getPlayableContentStatus(contentSource, articleDetection) {
	return Boolean(
		contentSource.metadata?.hasPlayableContent ||
			articleDetection.isReadableArticle ||
			articleDetection.canPlayBestEffort,
	);
}

function shouldAutoShow(contentSource, articleDetection) {
	return Boolean(
		contentSource.metadata?.autoShow || articleDetection.isReadableArticle,
	);
}

export default defineContentScript({
	matches: ["<all_urls>"],
	runAt: "document_idle",
	async main(ctx) {
		if (document.getElementById("pocket-speechify-host")) return;

		const host = document.createElement("div");
		host.id = "pocket-speechify-host";
		host.style.cssText =
			"all: initial; position: fixed; top: 0; left: 0; z-index: 2147483645; pointer-events: none;";
		document.body.appendChild(host);

		const shadow = host.attachShadow({ mode: "open" });

		const cssUrl = browser.runtime.getURL("css/player.css");
		const cssText = await fetch(cssUrl).then((r) => r.text());
		const style = document.createElement("style");
		style.textContent = cssText;
		shadow.appendChild(style);

		const pageUrl = new URL(location.href);
		const contentSource = createContentSource(pageUrl, document);
		const paragraphs = contentSource.getParagraphs();
		function articleSample() {
			let text = "";
			for (const paragraph of paragraphs) {
				text += `${paragraph.text}\n`;
				if (text.length >= 12000) break;
			}
			return text.slice(0, 12000);
		}
		const languageResolution = await resolvePageLanguage(pageUrl, document, articleSample());
		console.log(`[Pocket Speechify] Language resolved: ${languageResolution.activeLanguage} (${languageResolution.languageSource})`);
		const localProfiles = new Map();
		const unsavedLanguages = new Set();
		let profileWrites = Promise.resolve();
		let operationRevision = 0;
		let manualLanguage = false;
		async function profileRequest(type, language, patch) {
			const result = await chrome.runtime.sendMessage({ type, language, ...(patch ? { patch } : {}) });
			if (!result || result.error) throw new Error(result?.error || "Speech settings unavailable");
			return normalizeSpeechProfile(language, result);
		}
		async function loadProfile(language) {
			await profileWrites;
			if (!unsavedLanguages.has(language)) {
				try {
					localProfiles.set(language, await profileRequest("speech-profile-get", language));
				} catch (error) {
					console.warn("[Pocket Speechify] Could not load speech profile:", error);
				}
			}
			return localProfiles.get(language) || normalizeSpeechProfile(language);
		}
		function profileState(profile) {
			return { selectedModelId: profile.modelId, voiceId: profile.voiceId, speed: profile.speed };
		}
		const initialProfile = await loadProfile(languageResolution.activeLanguage);
		log.info(
			`Extracted ${paragraphs.length} paragraphs via ${contentSource.site}`,
		);
		const articleDetection = detectReadableArticle(document, paragraphs);
		const hasPlayableContent = getPlayableContentStatus(
			contentSource,
			articleDetection,
		);
		console.log(
			`[Pocket Speechify] Article detection triggered: site=${contentSource.site}, autoShow=${shouldAutoShow(contentSource, articleDetection)}, playable=${hasPlayableContent}, confidence=${articleDetection.confidence}`,
		);

		const state = createState({
			...languageResolution,
			...profileState(initialProfile),
			hasPlayableContent,
		});

		function saveProfile(patch) {
			const { activeLanguage, selectedModelId, voiceId, speed } = state.get();
			const profile = normalizeSpeechProfile(activeLanguage, { modelId: selectedModelId, voiceId, speed, ...patch });
			localProfiles.set(activeLanguage, profile);
			state.dispatch(profileState(profile));
			profileWrites = profileWrites.then(async () => {
				try {
					await profileRequest("speech-profile-update", activeLanguage, unsavedLanguages.has(activeLanguage) ? profile : patch);
					unsavedLanguages.delete(activeLanguage);
				} catch (error) {
					unsavedLanguages.add(activeLanguage);
					console.warn("[Pocket Speechify] Could not save speech profile:", error);
				}
				state.dispatch({ preferencesError: unsavedLanguages.has(state.get().activeLanguage) });
			});
			return profileWrites;
		}

		const tts = new RemoteTTS();
		tts.setLanguage(state.get().selectedModelId);
		tts.setVoice(state.get().voiceId);
		let activePlaybackPlan = createPlaybackPlan({
			paragraphs,
			playbackMode: contentSource.metadata?.playbackMode,
		});
		let currentTTSParagraphIndex = activePlaybackPlan.ttsStartParagraph;

		function currentPlaybackMode() {
			return contentSource.metadata?.playbackMode || "continuous";
		}

		function realParagraphIndex(ttsParagraphIndex) {
			return toGlobalParagraphIndex(activePlaybackPlan, ttsParagraphIndex);
		}

		// Position to restart from when the user seeks while paused: the paused
		// pipeline is cancelled, so resume() must start a new playback.
		let resumeFrom = null;
		// Last spoken word; currentWordIndex is null in silences between words.
		let lastWord = null;

		function resetPlaybackState() {
			resumeFrom = null;
			lastWord = null;
			state.dispatch({
				playback: "idle",
				currentParagraphIndex: null,
				currentSentenceIndex: null,
				currentWordIndex: null,
				downloadProgress: null,
			});
		}

		// Seconds per word at 1x, measured from generated audio per voice.
		const rateMeter = createRateMeter();

		function updateProgress() {
			const { playback, speed } = state.get();
			const progressParagraphs = playback === "idle"
				? (currentPlaybackMode() === "single" ? [] : paragraphs)
				: activePlaybackPlan.ttsParagraphs;
			state.dispatch({
				progress: computeProgress({
					paragraphs: progressParagraphs,
					scope: progressParagraphs.map((_, index) => index),
					position: playback === "idle" ? null : lastWord,
					secPerWord: rateMeter.secPerWord(),
					speed,
				}),
			});
		}

		// Wire TTS events to state updates
		tts.addEventListener("word", (e) => {
			currentTTSParagraphIndex = e.detail.paragraphIndex;
			const paragraphIndex = realParagraphIndex(currentTTSParagraphIndex);
			if (paragraphIndex === null) {
				actions.stop();
				return;
			}
			const { wordIndex } = e.detail;
			if (wordIndex !== null || lastWord?.paragraphIndex !== currentTTSParagraphIndex) {
				lastWord = { paragraphIndex: currentTTSParagraphIndex, wordIndex: wordIndex ?? 0 };
			}
			state.dispatch({
				currentParagraphIndex: paragraphIndex,
				currentWordIndex: wordIndex,
			});
		});

		tts.addEventListener("measured", (e) => {
			rateMeter.add(e.detail.sourceSec, e.detail.words);
			console.log(
				`[Pocket Speechify] Speech rate measured: ${rateMeter.secPerWord().toFixed(3)}s/word`,
			);
			updateProgress();
		});

		tts.addEventListener("end", () => {
			log.debug("TTS end — playback complete");
			resetPlaybackState();
		});

		tts.addEventListener("error", (e) => {
			console.error(`[Pocket Speechify] Playback failed: ${e.detail.error}`);
			tts.stop();
			resetPlaybackState();
		});

		tts.addEventListener("download-progress", (e) => {
			const { asset, voiceId, language, percent } = e.detail;
			const cacheLanguage = language || state.get().selectedModelId;
			state.dispatch({
				downloadProgress: { asset, voiceId, language: cacheLanguage, percent },
			});
			if (asset === "voice" && voiceId) {
				const key = state.voiceCacheKey(cacheLanguage, voiceId);
				const voiceCache = { ...state.get().voiceCache, [key]: "downloading" };
				state.dispatch({ voiceCache });
			}
		});

		tts.addEventListener("download-complete", (e) => {
			const { asset, voiceId, language } = e.detail;
			const cacheLanguage = language || state.get().selectedModelId;
			if (asset === "voice" && voiceId) {
				const key = state.voiceCacheKey(cacheLanguage, voiceId);
				const voiceCache = { ...state.get().voiceCache, [key]: "cached" };
				state.dispatch({ voiceCache, downloadProgress: null });
			} else {
				state.dispatch({
					...(asset === "model" ? { modelCached: true } : {}),
					downloadProgress: null,
				});
			}
		});

		tts.addEventListener("sentence", (e) => {
			state.dispatch({ currentSentenceIndex: e.detail.sentenceIndex });
		});

		tts.addEventListener("processed-text", (e) => {
			const { paragraphIndex, text } = e.detail;
			const globalParagraphIndex = realParagraphIndex(paragraphIndex);
			if (globalParagraphIndex === null) return;
			state.dispatch({
				ttsHistory: [
					...state.get().ttsHistory,
					{ text, paragraphIndex: globalParagraphIndex },
				],
			});
		});

		// Wire language and voiceId state changes to RemoteTTS
		state.subscribe((current, prev) => {
			const voiceChanged =
				current.voiceId !== prev.voiceId ||
				current.selectedModelId !== prev.selectedModelId;
			if (current.voiceId !== prev.voiceId) {
				tts.setVoice(current.voiceId);
			}
			if (current.selectedModelId !== prev.selectedModelId) {
				tts.setLanguage(current.selectedModelId);
			}
			// Speech rate differs per voice and language.
			if (voiceChanged) rateMeter.reset();
			if (
				voiceChanged ||
				current.playback !== prev.playback ||
				current.speed !== prev.speed ||
				current.currentParagraphIndex !== prev.currentParagraphIndex ||
				current.currentWordIndex !== prev.currentWordIndex
			) {
				updateProgress();
			}
		});

		function startPlayback(fromParagraph, fromWord = 0) {
			resumeFrom = null;
			activePlaybackPlan = createPlaybackPlan({
				paragraphs,
				fromParagraph,
				playbackMode: currentPlaybackMode(),
			});
			currentTTSParagraphIndex = activePlaybackPlan.ttsStartParagraph;
			lastWord = { paragraphIndex: currentTTSParagraphIndex, wordIndex: fromWord };
			console.log(
				`[Pocket Speechify] Playback plan triggered: mode=${activePlaybackPlan.playbackMode}, fromParagraph=${fromParagraph}, ttsParagraphs=${activePlaybackPlan.ttsParagraphs.length}`,
			);
			state.dispatch({
				playback: "playing",
				currentParagraphIndex: fromParagraph,
				currentSentenceIndex: paragraphs[fromParagraph].sentences.findIndex(sentence =>
					sentence.words.includes(paragraphs[fromParagraph].words[fromWord])),
				currentWordIndex: null,
			});
			updateProgress();
			tts.play(
				activePlaybackPlan.ttsParagraphs,
				activePlaybackPlan.ttsStartParagraph,
				fromWord,
				state.get().speed,
				state.get().selectedModelId,
			);
		}

		// Move to a sentence. Keeps playing if playing; otherwise remembers the
		// position so resume() restarts from it.
		function seekTo(paragraphIndex, sentenceIndex) {
			const fromWord = wordOffsetForSentence(
				paragraphs,
				paragraphIndex,
				sentenceIndex,
			);
			const { playback } = state.get();
			tts.stop();
			state.dispatch({
				currentParagraphIndex: paragraphIndex,
				currentSentenceIndex: sentenceIndex,
				currentWordIndex: fromWord,
			});
			if (playback === "playing") {
				startPlayback(paragraphIndex, fromWord);
			} else {
				activePlaybackPlan = createPlaybackPlan({ paragraphs, fromParagraph: paragraphIndex, playbackMode: currentPlaybackMode() });
				currentTTSParagraphIndex = activePlaybackPlan.ttsStartParagraph;
				resumeFrom = { paragraphIndex, fromWord };
				lastWord = { paragraphIndex: currentTTSParagraphIndex, wordIndex: fromWord };
				updateProgress();
			}
		}

		const actions = {
			async play(fromParagraph) {
				if (state.get().speechSettingsLoading) return;
				const target = fromParagraph === undefined ? null : paragraphs[fromParagraph];
				contentSource.refresh();
				const revision = ++operationRevision;
				const resolution = manualLanguage ? null : await resolvePageLanguage(new URL(location.href), document, articleSample());
				if (revision !== operationRevision) return;
				const language = resolution?.activeLanguage || state.get().activeLanguage;
				const profile = await loadProfile(language);
				if (revision !== operationRevision) return;
				state.dispatch({ ...resolution, ...profileState(profile), preferencesError: unsavedLanguages.has(language) });
				fromParagraph = target ? findParagraphIndex(paragraphs, target) : 0;
				if (fromParagraph < 0) return;
				if (!state.get().hasPlayableContent) {
					log.warn("play: page is not playable");
					return;
				}
				if (paragraphs.length === 0) {
					log.warn("play: no paragraphs");
					return;
				}
				log.debug(
					`play(fromParagraph=${fromParagraph}), speed=${state.get().speed}`,
				);
				startPlayback(fromParagraph);
			},
			pause() {
				log.debug("pause");
				state.dispatch({ playback: "paused" });
				tts.pause();
			},
			resume() {
				log.debug("resume");
				if (resumeFrom) {
					startPlayback(resumeFrom.paragraphIndex, resumeFrom.fromWord);
					return;
				}
				tts.resume();
				state.dispatch({ playback: "playing" });
			},
			stop() {
				log.debug("stop");
				operationRevision++;
				state.dispatch({ speechSettingsLoading: false });
				tts.stop();
				resetPlaybackState();
			},
			skipForward() {
				const { currentParagraphIndex: pIdx, currentSentenceIndex: sIdx } =
					state.get();
				const para = pIdx === null ? null : paragraphs[pIdx];
				if (!para) return;
				log.debug(`skipForward from p${pIdx}:s${sIdx}`);
				let newPIdx = pIdx,
					newSIdx = (sIdx ?? 0) + 1;
				if (newSIdx >= para.sentences.length) {
					newPIdx = pIdx + 1;
					newSIdx = 0;
				}
				if (
					newPIdx >= paragraphs.length ||
					!canMoveToParagraph(activePlaybackPlan, newPIdx)
				)
					return;
				seekTo(newPIdx, newSIdx);
			},
			skipBack() {
				const {
					currentParagraphIndex: pIdx,
					currentSentenceIndex: sIdx,
					currentWordIndex,
				} = state.get();
				if (pIdx === null || !paragraphs[pIdx] || sIdx === null) return;
				const sentenceStartWordIdx = wordOffsetForSentence(
					paragraphs,
					pIdx,
					sIdx,
				);
				const wIdx =
					currentWordIndex ??
					(lastWord && realParagraphIndex(lastWord.paragraphIndex) === pIdx
						? lastWord.wordIndex
						: sentenceStartWordIdx);
				log.debug(`skipBack from p${pIdx}:s${sIdx}:w${wIdx}`);
				let newPIdx = pIdx,
					newSIdx = sIdx;
				// Near the start of a sentence, go to the previous one; otherwise
				// restart the current sentence.
				if (wIdx - sentenceStartWordIdx < 2) {
					newSIdx = sIdx - 1;
					if (newSIdx < 0) {
						newPIdx = pIdx - 1;
						if (newPIdx < 0) {
							newPIdx = 0;
							newSIdx = 0;
						} else {
							newSIdx = paragraphs[newPIdx].sentences.length - 1;
						}
					}
				}
				if (!canMoveToParagraph(activePlaybackPlan, newPIdx)) return;
				seekTo(newPIdx, newSIdx);
			},
			async setSpeed(speed) {
				console.log(`[Pocket Speechify] Speed ${speed}x triggered`);
				if (state.get().speechSettingsLoading) return;
				operationRevision++;
				tts.setSpeed(speed);
				await saveProfile({ speed });
			},
			async setLanguage(languageId) {
				console.log(`[Pocket Speechify] Language ${languageId} triggered`);
				const revision = ++operationRevision;
				manualLanguage = true;
				tts.stop();
				resetPlaybackState();
				state.dispatch({ speechSettingsLoading: true, panelOpen: "voice" });
				const profile = await loadProfile(languageId);
				if (revision !== operationRevision) return;
				state.dispatch({
					activeLanguage: languageId,
					languageSource: "manual",
					...profileState(profile),
					speechSettingsLoading: false,
					preferencesError: unsavedLanguages.has(languageId),
				});
			},
			async setModel(modelId) {
				console.log(`[Pocket Speechify] Model ${modelId} triggered`);
				if (state.get().speechSettingsLoading || !isSupportedLanguage(modelId) || getLanguage(modelId).language !== state.get().activeLanguage) return;
				operationRevision++;
				tts.stop();
				resetPlaybackState();
				await saveProfile({ modelId });
			},
			async setVoice(voiceId) {
				console.log(`[Pocket Speechify] Voice ${voiceId} triggered`);
				if (state.get().speechSettingsLoading) return;
				operationRevision++;
				state.dispatch({ panelOpen: null });
				await saveProfile({ voiceId });
			},
		};

		updateProgress();

		await initPillPlayer(shadow, state, actions, paragraphs, {
			initiallyVisible: shouldAutoShow(contentSource, articleDetection),
			hasPlayableContent,
		});

		// Toolbar button: toggle pill visibility
		chrome.runtime.onMessage.addListener((msg) => {
			if (msg.type !== "toggle-pill") return;
			console.log("[Pocket Speechify] toolbar button clicked, toggling pill");
			const container = shadow.querySelector(".pill-container");
			if (!container) return;
			const isHidden = container.style.display === "none";
			container.style.display = isHidden ? "" : "none";
			state.dispatch({ pillUserHidden: !isHidden });
			console.log(
				`[Pocket Speechify] pill toggled, display: ${container.style.display || "visible"}`,
			);
		});

		initSidePanels(shadow, state, actions);

		let highlights = null;
		let hoverController = null;
		let scrollNavInitialized = false;

		function initializePlaybackHelpers(playable, autoShow) {
			if (playable && !highlights) {
				highlights = initHighlights(state, paragraphs);
			}
			if (autoShow && !hoverController) {
				hoverController = initHoverPlayer(shadow, state, paragraphs, actions);
			}
			if (autoShow && !scrollNavInitialized) {
				initScrollNav(state, paragraphs);
				scrollNavInitialized = true;
			}
		}

		initializePlaybackHelpers(
			hasPlayableContent,
			shouldAutoShow(contentSource, articleDetection),
		);

		contentSource.subscribe(() => {
			// An in-flight text detector describes the previous article snapshot.
			if (!state.get().speechSettingsLoading) operationRevision++;
			const nextArticleDetection = detectReadableArticle(document, paragraphs);
			const nextHasPlayableContent = getPlayableContentStatus(
				contentSource,
				nextArticleDetection,
			);
			const nextAutoShow = shouldAutoShow(contentSource, nextArticleDetection);
			console.log(
				`[Pocket Speechify] Content source updated: site=${contentSource.site}, paragraphs=${paragraphs.length}, playable=${nextHasPlayableContent}`,
			);
			state.dispatch({ hasPlayableContent: nextHasPlayableContent });
			if (state.get().playback !== "idle") {
				const remaining = activePlaybackPlan.ttsParagraphs
					.map((_, index) => realParagraphIndex(index))
					.slice(currentTTSParagraphIndex);
				// Keep the snapshot through insertions, but never speak edited,
				// removed or reordered queued text against the new DOM.
				if (remaining.some((index, i) => index === null || (i > 0 && index <= remaining[i - 1]))) {
					actions.stop();
				} else {
					if (resumeFrom) resumeFrom.paragraphIndex = remaining[0];
					state.dispatch({ currentParagraphIndex: remaining[0] });
				}
			}
			initializePlaybackHelpers(nextHasPlayableContent, nextAutoShow);
			highlights?.refresh();
			updateProgress();
			if (hoverController) hoverController.bindParagraphs();
			if (
				nextAutoShow &&
				nextHasPlayableContent &&
				!state.get().pillUserHidden
			) {
				const container = shadow.querySelector(".pill-container");
				if (container) container.style.display = "";
			}
		});

		ctx.onInvalidated(() => {
			console.log("[Pocket Speechify] Content cleanup triggered");
			operationRevision++;
			contentSource.destroy();
			highlights?.destroy();
			tts.destroy();
			host.remove();
		});
	},
});
