import type OpenAI from "openai";
import type { NarrationSegment } from "../../storyAudio";
import type { GeminiTtsModel } from "./constants";

export type TtsProvider = "openai" | "gemini";
export type TtsProviderPreference = TtsProvider | "auto";

export interface SpeechOptions {
	geminiModel?: GeminiTtsModel;
	instructions?: string;
	provider?: TtsProviderPreference;
	speed?: number;
	voice?: string;
}

export interface TtsRequest extends SpeechOptions {
	openai: OpenAI;
	text: string;
}

export interface ProviderTtsRequest extends SpeechOptions {
	input: string;
	openai: OpenAI;
}

export interface SynthesizedSpeech {
	audio: Buffer;
	extension: "mp3" | "wav";
	mimeType: "audio/mpeg" | "audio/wav";
	model: string;
	provider: TtsProvider;
	voice: string;
	/** Request boundaries when the audio was stitched from several requests. */
	segments?: NarrationSegment[];
}
