import type { GeminiTtsModel } from "./server/tts/constants";

export const TTS_MODELS = [
	{ id: "openai", label: "OpenAI (gpt-4o-mini-tts)" },
	{ id: "gemini-3.8-flash-tts", label: "Gemini 3.8 Flash" },
	{ id: "gemini-3.8-flash-lite-tts", label: "Gemini 3.8 Flash-Lite" },
] as const;

export type TtsModelId = (typeof TTS_MODELS)[number]["id"];
/**
 * Matches the model the app's stories are actually narrated with. A browser
 * with no stored selection — a new profile, cleared site data, a second device,
 * a headless verification run — falls back to this, and a fallback that
 * disagrees with the recordings on disk re-narrates them at cost.
 */
export const DEFAULT_TTS_MODEL: TtsModelId = "gemini-3.8-flash-lite-tts";

export function isTtsModelId(value: unknown): value is TtsModelId {
	return (
		typeof value === "string" && TTS_MODELS.some((item) => item.id === value)
	);
}

interface TtsModelInfo {
	provider: "openai" | "gemini";
	extension: "mp3" | "wav";
	mimeType: "audio/mpeg" | "audio/wav";
	model: string;
}

const TTS_MODEL_INFO: Record<TtsModelId, TtsModelInfo> = {
	openai: {
		provider: "openai",
		extension: "mp3",
		mimeType: "audio/mpeg",
		model: "gpt-4o-mini-tts",
	},
	"gemini-3.8-flash-tts": {
		provider: "gemini",
		extension: "wav",
		mimeType: "audio/wav",
		model: "gemini-3.8-flash-tts",
	},
	"gemini-3.8-flash-lite-tts": {
		provider: "gemini",
		extension: "wav",
		mimeType: "audio/wav",
		model: "gemini-3.8-flash-lite-tts",
	},
};

export function ttsModelInfo(id: TtsModelId): TtsModelInfo {
	return TTS_MODEL_INFO[id];
}

/** Options to merge into a `tts()` call to force the chosen provider/model. */
export function ttsModelSpeechOptions(id: TtsModelId): {
	provider: "openai" | "gemini";
	geminiModel?: GeminiTtsModel;
} {
	const info = ttsModelInfo(id);
	return info.provider === "gemini"
		? { provider: "gemini", geminiModel: info.model as GeminiTtsModel }
		: { provider: "openai" };
}
