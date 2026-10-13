import Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { ChatMessage } from "../ai";
import { DEFAULT_LANGUAGE, type Language } from "../languages";
import {
	DEFAULT_TEXT_MODEL,
	STORY_SEGMENT_MAX_TOKENS,
	type TextModelId,
	type TextReasoningEffort,
} from "../models";
import { AiTraceError, traceAiCall } from "./aiTrace";

type AnthropicMessages = {
	systemContent: string;
	conversationMessages: Array<{
		role: "user" | "assistant";
		content: string;
	}>;
};

type GeminiContent = {
	role: "user" | "model";
	parts: Array<{ text: string }>;
};

type GeminiGenerateContentResponse = {
	candidates?: Array<{
		content?: {
			parts?: Array<{ text?: string }>;
		};
		finishReason?: string;
	}>;
};

type CompletionOutput = "text" | "structured";
type CompletionOptions = { reasoningEffort?: TextReasoningEffort };

export async function completeAi(
	openai: OpenAI,
	messages: ChatMessage[],
	maxTokens = STORY_SEGMENT_MAX_TOKENS,
	model: TextModelId = DEFAULT_TEXT_MODEL,
	anthropicKey = "",
	options: CompletionOptions = {},
): Promise<string> {
	return completeAiOutput(
		openai,
		messages,
		maxTokens,
		model,
		anthropicKey,
		"text",
		options,
	);
}

/** Completes a structured request without prose normalization corrupting JSON. */
export async function completeStructuredAi(
	openai: OpenAI,
	messages: ChatMessage[],
	maxTokens = STORY_SEGMENT_MAX_TOKENS,
	model: TextModelId = DEFAULT_TEXT_MODEL,
	anthropicKey = "",
	options: CompletionOptions = {},
): Promise<string> {
	return completeAiOutput(
		openai,
		messages,
		maxTokens,
		model,
		anthropicKey,
		"structured",
		options,
	);
}

async function completeAiOutput(
	openai: OpenAI,
	messages: ChatMessage[],
	maxTokens: number,
	model: string,
	anthropicKey: string,
	output: CompletionOutput,
	options: CompletionOptions,
): Promise<string> {
	if (model.startsWith("claude-")) {
		return completeAnthropic(messages, maxTokens, model, anthropicKey, output);
	}
	if (model.startsWith("gemini-")) {
		return completeGemini(messages, maxTokens, model, output);
	}
	return completeOpenAi(openai, messages, maxTokens, model, output, options);
}

export async function translateWords(
	openai: OpenAI,
	genreOrWords: Language | string[],
	wordsOrContext?: string[] | string,
	storyContext?: string,
): Promise<Record<string, string>> {
	const genre = Array.isArray(genreOrWords) ? DEFAULT_LANGUAGE : genreOrWords;
	const words = Array.isArray(genreOrWords)
		? genreOrWords
		: (wordsOrContext as string[]);
	const resolvedStoryContext = Array.isArray(genreOrWords)
		? (wordsOrContext as string | undefined)
		: storyContext;
	if (words.length === 0) return {};
	const context = resolvedStoryContext?.trim();
	const systemContent =
		`You are a ${genre.label}-English dictionary for a language-learning app. Given a JSON array of ${genre.label} words, return a JSON object mapping each exact input word to a concise, natural English gloss — the short label a learner sees on hover. Give the single most likely meaning. Only when a word is genuinely ambiguous, offer at most two alternatives separated by a slash. Reflect grammatical distinctions only through your choice of English words; never add explanatory notes, parenthetical annotations, part-of-speech labels, or grammar commentary. Do not omit any input word. Return only valid JSON, with no markdown or explanation.` +
		(context
			? ` The words are taken from the ${genre.label} reading story below. Gloss each word as it is used in THIS story, choosing the sense the context supports.\n\nStory:\n${context}`
			: "");
	const messages: ChatMessage[] = [
		{ role: "system", content: systemContent },
		{ role: "user", content: JSON.stringify(words) },
	];
	const response = await traceAiCall(
		{
			kind: "text.translation",
			provider: "openai",
			model: DEFAULT_TEXT_MODEL,
			input: messages,
			metadata: {
				maxTokens: 4000,
				reasoningEffort: "none",
				words: words.length,
			},
		},
		() =>
			openai.chat.completions.create({
				model: DEFAULT_TEXT_MODEL,
				max_completion_tokens: 4000,
				messages,
				reasoning_effort: "none",
			}),
		(value) => value.choices[0]?.message?.content ?? "",
	);
	const raw = response.choices[0]?.message?.content?.trim() ?? "";
	try {
		return JSON.parse(raw) as Record<string, string>;
	} catch {
		console.warn("translateWords: could not parse AI response", raw);
		return {};
	}
}

async function completeOpenAi(
	openai: OpenAI,
	messages: ChatMessage[],
	maxTokens: number,
	model: string,
	output: CompletionOutput,
	options: CompletionOptions,
): Promise<string> {
	if (!process.env.OPENAI_API_KEY) {
		throw new Error("OpenAI API key is not configured.");
	}
	const reasoningEffort =
		options.reasoningEffort ??
		(model.startsWith("gpt-5.6") || model === "gpt-6-luna"
			? "none"
			: undefined);
	const response = await traceAiCall(
		{
			kind: "text.complete",
			provider: "openai",
			model,
			input: messages,
			metadata: { maxTokens, reasoningEffort },
		},
		async () => {
			const completion = await openai.chat.completions.create({
				model,
				max_completion_tokens: maxTokens,
				messages,
				reasoning_effort: reasoningEffort,
			});
			const choice = completion.choices[0];
			if (!choice?.message?.content?.trim()) {
				throw new AiTraceError("The AI returned an empty response.", {
					responseId: completion.id,
					finishReason: choice?.finish_reason,
					refusal: choice?.message?.refusal,
					usage: completion.usage,
					choiceCount: completion.choices.length,
				});
			}
			return completion;
		},
		(value) => value.choices[0]?.message?.content ?? "",
	);
	const choice = response.choices[0];
	const raw = choice?.message?.content?.trim();
	if (!raw) throw new Error("The AI returned an empty response.");
	return finishCompletion(raw, choice?.finish_reason === "length", output);
}

async function completeAnthropic(
	messages: ChatMessage[],
	maxTokens: number,
	model: string,
	apiKey: string,
	output: CompletionOutput,
): Promise<string> {
	if (!apiKey) throw new Error("Anthropic API key is not configured.");
	const anthropic = new Anthropic({ apiKey });
	const { systemContent, conversationMessages } = toAnthropicMessages(messages);

	const response = await traceAiCall(
		{
			kind: "text.complete",
			provider: "anthropic",
			model,
			input: { system: systemContent, messages: conversationMessages },
			metadata: { maxTokens },
		},
		() =>
			anthropic.messages.create({
				model,
				max_tokens: maxTokens,
				...(model === "claude-haiku-5-5"
					? { thinking: { type: "disabled" as const } }
					: {}),
				...(systemContent ? { system: systemContent } : {}),
				messages: conversationMessages,
			}),
		(value) =>
			value.content
				.map((block) => (block.type === "text" ? block.text : ""))
				.join(""),
	);

	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	if (!text.trim()) throw new Error("The AI returned an empty response.");
	return finishCompletion(text, response.stop_reason === "max_tokens", output);
}

async function completeGemini(
	messages: ChatMessage[],
	maxTokens: number,
	model: string,
	output: CompletionOutput = "text",
): Promise<string> {
	const response = await requestGemini(messages, maxTokens, model);
	const choice = response.candidates?.[0];
	const raw = choice?.content?.parts
		?.map((part) => part.text ?? "")
		.join("")
		.trim();
	if (!raw) throw new Error("The AI returned an empty response.");
	return finishCompletion(raw, choice?.finishReason === "MAX_TOKENS", output);
}

function finishCompletion(
	raw: string,
	truncated: boolean,
	output: CompletionOutput,
): string {
	const text = raw.trim();
	return truncated && output !== "structured"
		? trimToSentenceBoundary(text)
		: text;
}

async function requestGemini(
	messages: ChatMessage[],
	maxTokens: number,
	model: string,
): Promise<GeminiGenerateContentResponse> {
	const apiKey = process.env.GEMINI_API_KEY ?? "";
	if (!apiKey) throw new Error("Gemini API key is not configured.");
	const { systemContent, conversationMessages } = toGeminiMessages(messages);

	const body = {
		contents: conversationMessages,
		generationConfig: {
			// Gemini counts thinking tokens against the output ceiling too.
			maxOutputTokens:
				model === "gemini-3.8-flash" ? Math.max(maxTokens, 2048) : maxTokens,
			...(model === "gemini-3.8-flash"
				? { thinkingConfig: { thinkingLevel: "low" } }
				: {}),
		},
		...(systemContent
			? {
					systemInstruction: {
						parts: [{ text: systemContent }],
					},
				}
			: {}),
	};
	return traceAiCall(
		{
			kind: "text.complete",
			provider: "gemini",
			model,
			input: body,
			metadata: { maxTokens },
		},
		async () => {
			const response = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
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
				throw new Error(
					`Gemini request failed: ${response.status} ${response.statusText}`,
				);
			}

			return (await response.json()) as GeminiGenerateContentResponse;
		},
		(value) =>
			value.candidates?.[0]?.content?.parts
				?.map((part) => part.text ?? "")
				.join("") ?? "",
	);
}

/**
 * When a completion is cut off by the token ceiling, the tail is usually a
 * partial sentence or word. Roll the text back to the last sentence-ending
 * punctuation. Applied only when the model was actually truncated, leaving
 * naturally-finished prose untouched.
 */
function trimToSentenceBoundary(text: string): string {
	const match = text.match(/^[\s\S]*[.!?]["')\]]*/);
	return match ? match[0].trimEnd() : text;
}

function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessages {
	return {
		systemContent: messages
			.filter((m) => m.role === "system")
			.map((m) => m.content)
			.join("\n\n"),
		conversationMessages: messages
			.filter((m) => m.role !== "system")
			.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			})),
	};
}

function toGeminiMessages(messages: ChatMessage[]): {
	systemContent: string;
	conversationMessages: GeminiContent[];
} {
	const systemContent = messages
		.filter((m) => m.role === "system")
		.map((m) => m.content)
		.join("\n\n");
	const conversationMessages = messages
		.filter((m) => m.role !== "system")
		.map<GeminiContent>((m) => ({
			role: m.role === "assistant" ? "model" : "user",
			parts: [{ text: m.content }],
		}));

	return {
		systemContent,
		conversationMessages:
			conversationMessages.length > 0
				? conversationMessages
				: [{ role: "user", parts: [{ text: systemContent }] }],
	};
}
