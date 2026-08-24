import { traceAiCall } from "../aiTrace";
import { OPENAI_TTS_MODEL, OPENAI_TTS_VOICE } from "./constants";
import type { ProviderTtsRequest, SynthesizedSpeech } from "./types";

export async function synthesizeOpenAiSpeech({
	openai,
	input,
	instructions,
	speed,
	voice,
}: ProviderTtsRequest): Promise<SynthesizedSpeech> {
	if (!process.env.OPENAI_API_KEY?.trim()) {
		throw new Error("OpenAI API key is not configured.");
	}
	const selectedVoice = voice ?? OPENAI_TTS_VOICE;
	const response = await traceAiCall(
		{
			kind: "audio.speech",
			provider: "openai",
			model: OPENAI_TTS_MODEL,
			input: { input, instructions },
			metadata: {
				responseFormat: "mp3",
				speed,
				voice: selectedVoice,
			},
		},
		() =>
			openai.audio.speech.create({
				model: OPENAI_TTS_MODEL,
				voice: selectedVoice,
				input,
				...(instructions ? { instructions } : {}),
				response_format: "mp3",
				...(speed ? { speed } : {}),
			}),
		(value) => ({
			contentType: value.headers.get("content-type"),
		}),
	);
	return {
		audio: Buffer.from(await response.arrayBuffer()),
		extension: "mp3",
		mimeType: "audio/mpeg",
		model: OPENAI_TTS_MODEL,
		provider: "openai",
		voice: selectedVoice,
	};
}
