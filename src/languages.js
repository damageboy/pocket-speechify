export const DEFAULT_LANGUAGE_ID = "english";

export const POCKET_TTS_V2_REPO = "kyutai/pocket-tts-without-voice-cloning";
export const POCKET_TTS_V2_MODEL_REVISION =
	"d29db7978e464fb90cb3359ee0c69a273b9142cc";
export const POCKET_TTS_V2_VOICE_REVISION =
	"e041936c75475d350b405bc870bcf7c22da4e9e6";

export const LANGUAGES = [
	{
		id: "english",
		description: "English (latest)",
		defaultVoice: "alba",
		status: "production",
		layers: 6,
		flag: "🇬🇧",
		removeSemicolons: false,
		framesAfterEos: null,
	},
	{
		id: "german",
		description: "German",
		defaultVoice: "juergen",
		status: "production",
		layers: 6,
		flag: "🇩🇪",
		removeSemicolons: true,
		framesAfterEos: null,
	},
	{
		id: "italian",
		description: "Italian",
		defaultVoice: "giovanni",
		status: "production",
		layers: 6,
		flag: "🇮🇹",
		removeSemicolons: false,
		framesAfterEos: null,
	},
	{
		id: "portuguese",
		description: "Portuguese",
		defaultVoice: "rafael",
		status: "production",
		layers: 6,
		flag: "🇧🇷",
		removeSemicolons: false,
		framesAfterEos: null,
	},
	{
		id: "spanish",
		description: "Spanish",
		defaultVoice: "lola",
		status: "production",
		layers: 6,
		flag: "🇪🇸",
		removeSemicolons: false,
		framesAfterEos: null,
	},
	{
		id: "french_24l",
		description: "French (24-layer preview)",
		defaultVoice: "estelle",
		status: "preview",
		layers: 24,
		flag: "🇫🇷",
		removeSemicolons: true,
		framesAfterEos: 8,
	},
];

const LANGUAGE_BY_ID = Object.fromEntries(LANGUAGES.map((l) => [l.id, l]));

export function getLanguage(languageId) {
	return LANGUAGE_BY_ID[languageId] || LANGUAGE_BY_ID[DEFAULT_LANGUAGE_ID];
}

export function isSupportedLanguage(languageId) {
	return Boolean(LANGUAGE_BY_ID[languageId]);
}

export function getDefaultVoiceForLanguage(languageId) {
	return getLanguage(languageId).defaultVoice;
}

export function languageFlag(languageId) {
	return getLanguage(languageId).flag;
}

export function languageFromLocale(locale) {
	if (!locale || typeof locale !== "string") return null;
	const normalized = locale.trim().toLowerCase().replace("_", "-");
	const primary = normalized.split("-")[0];
	const map = {
		en: "english",
		de: "german",
		it: "italian",
		pt: "portuguese",
		es: "spanish",
		fr: "french_24l",
	};
	return map[primary] || null;
}

export function getModelCacheKey(languageId) {
	return `languages/${getLanguage(languageId).id}/model.safetensors`;
}

export function getTokenizerCacheKey(languageId) {
	return `languages/${getLanguage(languageId).id}/tokenizer.model`;
}

export function getVoiceCacheKey(languageId, voiceId) {
	return `languages/${getLanguage(languageId).id}/embeddings/${voiceId}.safetensors`;
}

function hfUrl(revision, path) {
	return `https://huggingface.co/${POCKET_TTS_V2_REPO}/resolve/${revision}/${path}`;
}

export function getModelUrl(languageId) {
	return hfUrl(POCKET_TTS_V2_MODEL_REVISION, getModelCacheKey(languageId));
}

export function getTokenizerUrl(languageId) {
	return hfUrl(POCKET_TTS_V2_MODEL_REVISION, getTokenizerCacheKey(languageId));
}

export function getVoiceUrl(languageId, voiceId) {
	return hfUrl(
		POCKET_TTS_V2_VOICE_REVISION,
		getVoiceCacheKey(languageId, voiceId),
	);
}

export function buildLanguageConfigYaml(languageId) {
	const lang = getLanguage(languageId);
	let header = "";
	if (lang.removeSemicolons) header += "remove_semicolons: true\n";
	if (lang.framesAfterEos !== null)
		header += `model_recommended_frames_after_eos: ${lang.framesAfterEos}\n`;

	return `${header}
flow_lm:
  insert_bos_before_voice: true
  dtype: float32
  flow:
    depth: 6
    dim: 512
  transformer:
    d_model: 1024
    hidden_scale: 4
    max_period: 10000
    num_heads: 16
    num_layers: ${lang.layers}
  lookup_table:
    dim: 1024
    n_bins: 4000
    tokenizer: sentencepiece
    tokenizer_path: dummy

mimi:
  dtype: float32
  sample_rate: 24000
  inner_dim: 32
  outer_dim: 512
  channels: 1
  frame_rate: 12.5
  seanet:
    dimension: 512
    channels: 1
    n_filters: 64
    n_residual_layers: 1
    ratios: [6, 5, 4]
    kernel_size: 7
    residual_kernel_size: 3
    last_kernel_size: 3
    dilation_base: 2
    pad_mode: constant
    compress: 2
  transformer:
    d_model: 512
    num_heads: 8
    num_layers: 2
    layer_scale: 0.01
    context: 250
    dim_feedforward: 2048
    input_dimension: 512
    output_dimensions: [512]
  quantizer:
    dimension: 32
    output_dimension: 512
`;
}
