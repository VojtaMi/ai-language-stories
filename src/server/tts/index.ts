import type OpenAI from "openai";
import { TTS_MAX_INPUT_CHARS } from "./constants";
import { synthesizeGeminiSpeech } from "./geminiTts";
import { synthesizeOpenAiSpeech } from "./openaiTts";
import type {
	SpeechOptions,
	SynthesizedSpeech,
	TtsProvider,
	TtsRequest,
} from "./types";

export type { GeminiTtsModel } from "./constants";
export {
	DEFAULT_GEMINI_TTS_MODEL,
	GEMINI_TTS_MODELS,
	OPENAI_TTS_MODEL,
} from "./constants";
export type { SpeechOptions, SynthesizedSpeech, TtsProvider, TtsRequest };

export async function synthesizeSpeech(
	openai: OpenAI,
	text: string,
	options: SpeechOptions = {},
): Promise<Buffer> {
	return (await tts({ openai, text, ...options, provider: "openai" })).audio;
}

export async function tts({
	openai,
	text,
	...options
}: TtsRequest): Promise<SynthesizedSpeech> {
	const input = text.trim();
	if (!input) throw new Error("No text to narrate.");
	if (input.length > TTS_MAX_INPUT_CHARS) {
		throw new Error("The passage is too long to narrate.");
	}

	const requestedProvider =
		options.provider === "auto" || !options.provider
			? process.env.GEMINI_API_KEY
				? "gemini"
				: "openai"
			: options.provider;
	// A saved Gemini selection must remain usable when an app is shared with
	// only an OpenAI key. The UI normally changes the selection too, but this
	// server-side fallback also covers stale browser storage and direct calls.
	if (requestedProvider === "gemini" && process.env.GEMINI_API_KEY?.trim()) {
		return synthesizeGeminiSpeech({ openai, input, ...options });
	}

	return synthesizeOpenAiSpeech({ openai, input, ...options });
}
