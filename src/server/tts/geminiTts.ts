import { AiTraceError, traceAiCall } from "../aiTrace";
import { summarizeGeminiResponse } from "../geminiTrace";
import { DEFAULT_GEMINI_TTS_MODEL } from "./constants";
import type { ProviderTtsRequest, SynthesizedSpeech } from "./types";
import { geminiVoice } from "./voices";
import { pcmToWav } from "./wav";

type GeminiGenerateContentResponse = {
	candidates?: Array<{
		content?: {
			parts?: Array<{
				inlineData?: {
					data?: string;
					mimeType?: string;
				};
				text?: string;
			}>;
		};
		finishReason?: string;
		safetyRatings?: unknown;
	}>;
	promptFeedback?: unknown;
	usageMetadata?: unknown;
};

const GEMINI_TTS_MAX_ATTEMPTS = 3;

class RetryableGeminiTtsError extends Error {}

/** A 429: the quota is spent, so retrying within seconds only spends more of it. */
class GeminiTtsRateLimitError extends Error {}

export function isGeminiTtsRateLimit(error: unknown): boolean {
	return error instanceof GeminiTtsRateLimitError;
}

/** Gemini's 429 body names the exhausted quota, which the status alone does not. */
async function geminiRateLimitError(
	response: Response,
	message: string,
): Promise<GeminiTtsRateLimitError> {
	const body = (await response.json().catch(() => null)) as {
		error?: { message?: string };
	} | null;
	const detail = body?.error?.message?.split("\n")[0];
	return new GeminiTtsRateLimitError(
		detail ? `${message}: ${detail}` : message,
	);
}

export async function synthesizeGeminiSpeech({
	geminiModel,
	input,
	instructions,
	voice,
}: ProviderTtsRequest): Promise<SynthesizedSpeech> {
	const apiKey = process.env.GEMINI_API_KEY ?? "";
	if (!apiKey) throw new Error("Gemini API key is not configured.");

	const selectedModel = geminiModel ?? DEFAULT_GEMINI_TTS_MODEL;
	const selectedVoice = geminiVoice(voice);
	const prompt = [
		"Synthesize speech for a language-learning app.",
		instructions,
		"Read only the transcript. Keep pronunciation careful, natural, and learner-friendly.",
		"",
		"Transcript:",
		input,
	]
		.filter(Boolean)
		.join("\n");
	const usesSpeechMetadata = selectedModel.startsWith("gemini-3.8-");
	const body = {
		contents: [
			{
				parts: [
					usesSpeechMetadata
						? {
								text: input,
								speech_metadata: {
									style: [
										instructions,
										"Keep pronunciation careful, natural, and learner-friendly.",
									]
										.filter(Boolean)
										.join("\n"),
								},
							}
						: { text: prompt },
				],
			},
		],
		generationConfig: {
			responseModalities: ["AUDIO"],
			speechConfig: {
				voiceConfig: usesSpeechMetadata
					? { voice: selectedVoice }
					: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
			},
		},
	};
	let inlineData: { data: string; mimeType?: string } | undefined;
	for (let attempt = 1; attempt <= GEMINI_TTS_MAX_ATTEMPTS; attempt += 1) {
		try {
			inlineData = await traceAiCall(
				{
					kind: "audio.speech",
					provider: "gemini",
					model: selectedModel,
					input: body,
					metadata: { voice: selectedVoice, attempt },
				},
				async () => {
					const response = await fetch(
						`https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								"x-goog-api-key": apiKey,
							},
							body: JSON.stringify(body),
						},
					);

					if (!response.ok) {
						const message = `Gemini TTS request failed: ${response.status} ${response.statusText}`;
						if (response.status === 429) {
							throw await geminiRateLimitError(response, message);
						}
						if (response.status >= 500) {
							throw new RetryableGeminiTtsError(message);
						}
						throw new Error(message);
					}

					const json = (await response.json()) as GeminiGenerateContentResponse;
					const audio = json.candidates
						?.flatMap((candidate) => candidate.content?.parts ?? [])
						.find((part) => part.inlineData?.data)?.inlineData;
					if (!audio?.data) {
						throw new AiTraceError(
							"Gemini TTS response did not include audio data.",
							summarizeGeminiResponse(json),
						);
					}

					return { data: audio.data, mimeType: audio.mimeType };
				},
				(value) => ({
					audioChars: value.data?.length ?? 0,
					mimeType: value.mimeType,
				}),
			);
			break;
		} catch (error) {
			const retryable =
				error instanceof AiTraceError ||
				error instanceof RetryableGeminiTtsError ||
				error instanceof TypeError;
			if (!retryable || attempt === GEMINI_TTS_MAX_ATTEMPTS) throw error;
			await waitBeforeGeminiTtsRetry(attempt);
		}
	}

	if (!inlineData) {
		throw new Error("Gemini TTS did not produce audio.");
	}

	const data = Buffer.from(inlineData.data, "base64");
	return {
		audio: usesSpeechMetadata ? data : pcmToWav(data),
		extension: "wav",
		mimeType: "audio/wav",
		model: selectedModel,
		provider: "gemini",
		voice: selectedVoice,
	};
}

async function waitBeforeGeminiTtsRetry(attempt: number) {
	const baseDelayMs = 250 * 2 ** (attempt - 1);
	const jitterMs = Math.floor(Math.random() * 150);
	await new Promise((resolve) => setTimeout(resolve, baseDelayMs + jitterMs));
}
