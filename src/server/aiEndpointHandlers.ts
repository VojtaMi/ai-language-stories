import type { IncomingMessage, ServerResponse } from "node:http";
import type OpenAI from "openai";
import type { ChatMessage } from "../ai";
import {
	getLanguage,
	isLanguageId,
	languageTtsInstructions,
} from "../languages";
import {
	DEFAULT_TEXT_MODEL,
	STORY_SEGMENT_MAX_TOKENS,
	TEXT_REASONING_EFFORTS,
	type TextReasoningEffort,
} from "../models";
import { isNarrationVoiceId } from "../narrationVoice";
import { parseNextStoryBrief } from "../nextStoryBrief";
import { READING_STORY_MAX_PARTS } from "../reading_story/split";
import { isStoryDifficulty } from "../storyFeedback";
import { DEFAULT_TTS_MODEL, isTtsModelId } from "../ttsModel";
import { completeAi, completeStructuredAi, translateWords } from "./aiService";
import { withAiTraceMetadata } from "./aiTrace";
import { readBody, sendJson } from "./http";
import { enqueueLearnerProfileMutation } from "./learnerProfileMutationQueue";
import { readLearnerContext, writeLearnerContext } from "./learnerProfileStore";
import { appendLearnerWordLogEntry } from "./learnerWordLogStore";
import { createBackgroundImage, findLanguage } from "./openingsStore";
import { createOpeningAudio } from "./storyAudioStore";
import { storyIdPattern } from "./storyBundleStore";
import {
	finalizeStoryEvidence,
	type StoryFinalizationInput,
} from "./storyFinalizationService";
import {
	getOrCreateWordAudio,
	regenerateWordAudio,
	wordFilePattern,
} from "./wordAudioStore";

const learnerWordPattern = /^\p{L}+(?:[-’']\p{L}+)*$/u;

export async function handleBackgroundImageRequest(
	req: IncomingMessage,
	res: ServerResponse,
	openai: OpenAI,
) {
	const {
		genreId,
		messages,
		storyId,
		sectionIndex,
		visualContext,
		anchorToFirstSection,
	} = JSON.parse(await readBody(req));
	const genre = findLanguage(genreId);
	if (!genre) {
		sendJson(res, 404, { error: "Language not found." });
		return;
	}
	if (
		!storyId ||
		typeof storyId !== "string" ||
		!storyIdPattern.test(storyId)
	) {
		sendJson(res, 400, { error: "storyId is required." });
		return;
	}
	sendJson(
		res,
		200,
		await withAiTraceMetadata(
			{ storyId, storyPhase: "media", mediaType: "background-image" },
			() =>
				createBackgroundImage(
					openai,
					genre,
					storyTextFromMessages(messages),
					storyId,
					{
						anchorToFirstSection: anchorToFirstSection === true,
						sectionIndex: validSectionIndex(sectionIndex),
						visualContext:
							typeof visualContext === "string" ? visualContext : undefined,
					},
				),
		),
	);
}

export async function handleOpeningAudioRequest(
	req: IncomingMessage,
	res: ServerResponse,
	openai: OpenAI,
) {
	const { genreId, text, storyId, narrationVoice, sectionIndex, ttsModel } =
		JSON.parse(await readBody(req));
	if (!isLanguageId(genreId)) {
		sendJson(res, 400, { error: "genreId is invalid." });
		return;
	}
	if (!text || typeof text !== "string") {
		sendJson(res, 400, { error: "text is required." });
		return;
	}
	if (
		!storyId ||
		typeof storyId !== "string" ||
		!storyIdPattern.test(storyId)
	) {
		sendJson(res, 400, { error: "storyId is required." });
		return;
	}
	if (!isNarrationVoiceId(narrationVoice)) {
		sendJson(res, 400, { error: "narrationVoice is required." });
		return;
	}
	const audio = await withAiTraceMetadata(
		{ storyId, storyPhase: "media", mediaType: "narration" },
		() =>
			createOpeningAudio(openai, text, storyId, narrationVoice, {
				sectionIndex: validSectionIndex(sectionIndex),
				ttsModel: isTtsModelId(ttsModel) ? ttsModel : DEFAULT_TTS_MODEL,
				instructions: languageTtsInstructions(getLanguage(genreId)),
			}),
	);
	if (!audio) {
		sendJson(res, 500, { error: "Could not generate opening audio." });
		return;
	}
	sendJson(res, 200, audio);
}

function validSectionIndex(value: unknown) {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

export async function handleRegenerateWordRequest(
	req: IncomingMessage,
	res: ServerResponse,
	openai: OpenAI,
) {
	const { genreId, word, storyContext } = JSON.parse(await readBody(req));
	if (!isLanguageId(genreId)) {
		sendJson(res, 400, { error: "genreId is invalid." });
		return;
	}
	if (!word || typeof word !== "string") {
		sendJson(res, 400, { error: "word is required." });
		return;
	}
	const context = typeof storyContext === "string" ? storyContext : undefined;
	const fresh = await translateWords(
		openai,
		getLanguage(genreId),
		[word],
		context,
	);
	sendJson(res, 200, { translation: fresh[word] ?? null });
}

export async function handleWordAudioRequest(
	req: IncomingMessage,
	res: ServerResponse,
	openai: OpenAI,
) {
	const { genreId, word } = JSON.parse(await readBody(req));
	if (!isLanguageId(genreId)) {
		sendJson(res, 400, { error: "genreId is invalid." });
		return;
	}
	if (!word || typeof word !== "string") {
		sendJson(res, 400, { error: "word is required." });
		return;
	}
	const normalizedWord = word.toLowerCase();
	if (!wordFilePattern.test(`${normalizedWord}.mp3`)) {
		sendJson(res, 400, { error: "word contains unsupported characters." });
		return;
	}
	const url = await getOrCreateWordAudio(openai, genreId, normalizedWord);
	sendJson(res, 200, { url });
}

export async function handleRegenerateWordAudioRequest(
	req: IncomingMessage,
	res: ServerResponse,
	openai: OpenAI,
) {
	const { genreId, word } = JSON.parse(await readBody(req));
	if (!isLanguageId(genreId)) {
		sendJson(res, 400, { error: "genreId is invalid." });
		return;
	}
	if (!word || typeof word !== "string") {
		sendJson(res, 400, { error: "word is required." });
		return;
	}
	const normalizedWord = word.toLowerCase();
	if (!wordFilePattern.test(`${normalizedWord}.mp3`)) {
		sendJson(res, 400, { error: "word contains unsupported characters." });
		return;
	}
	const url = await regenerateWordAudio(openai, genreId, normalizedWord);
	sendJson(res, 200, { url });
}

export async function handleCompleteRequest(
	req: IncomingMessage,
	res: ServerResponse,
	openai: OpenAI,
	anthropicKey: string,
) {
	const {
		messages,
		maxTokens = STORY_SEGMENT_MAX_TOKENS,
		model = DEFAULT_TEXT_MODEL,
		responseFormat = "text",
		reasoningEffort,
	} = JSON.parse(await readBody(req));
	if (responseFormat !== "text" && responseFormat !== "json") {
		sendJson(res, 400, { error: "responseFormat must be text or json." });
		return;
	}
	if (
		reasoningEffort !== undefined &&
		!TEXT_REASONING_EFFORTS.includes(reasoningEffort as TextReasoningEffort)
	) {
		sendJson(res, 400, { error: "reasoningEffort is invalid." });
		return;
	}
	const complete =
		responseFormat === "json" ? completeStructuredAi : completeAi;
	sendJson(res, 200, {
		text: await complete(openai, messages, maxTokens, model, anthropicKey, {
			reasoningEffort,
		}),
	});
}

export async function handleLearnerProfileGetRequest(
	_req: IncomingMessage,
	res: ServerResponse,
) {
	const context = await readLearnerContext();
	sendJson(res, 200, context);
}

export async function handleLearnerPreferencesUpdateRequest(
	req: IncomingMessage,
	res: ServerResponse,
) {
	const body = JSON.parse(await readBody(req));
	const fields = ["prefer", "avoid"] as const;
	if (
		!body ||
		typeof body !== "object" ||
		fields.some(
			(field) =>
				body[field] !== undefined &&
				(!Array.isArray(body[field]) ||
					body[field].some((item: unknown) => typeof item !== "string")),
		)
	) {
		sendJson(res, 400, { error: "Preferences must contain string arrays." });
		return;
	}

	try {
		const updated = await enqueueLearnerProfileMutation(async () => {
			const current = await readLearnerContext();
			const preferences = {
				...current.preferences,
				...Object.fromEntries(
					fields
						.filter((field) => body[field] !== undefined)
						.map((field) => [field, body[field]]),
				),
				updated: new Date().toISOString().slice(0, 10),
			};
			await writeLearnerContext({ ...current, preferences });
			return preferences;
		});
		sendJson(res, 200, updated);
	} catch (err) {
		console.warn("Could not update learner preferences.", err);
		sendJson(res, 400, { error: "Could not save valid learner preferences." });
	}
}

export async function handleFinalizeStoryEvidenceRequest(
	req: IncomingMessage,
	res: ServerResponse,
	openai: OpenAI,
	anthropicKey: string,
) {
	const body = JSON.parse(
		await readBody(req),
	) as Partial<StoryFinalizationInput>;
	if (!isLanguageId(body.genreId)) {
		sendJson(res, 400, { error: "genreId is invalid." });
		return;
	}
	if (typeof body.storyId !== "string" || !storyIdPattern.test(body.storyId)) {
		sendJson(res, 400, { error: "storyId must be a valid story ID." });
		return;
	}
	if (typeof body.storySummary !== "string" || !body.storySummary.trim()) {
		sendJson(res, 400, { error: "storySummary must be a non-empty string." });
		return;
	}
	if (
		!Array.isArray(body.storyParts) ||
		body.storyParts.length < 2 ||
		body.storyParts.length > READING_STORY_MAX_PARTS ||
		body.storyParts.some(
			(part) => typeof part !== "string" || !part.trim() || part.length > 5000,
		)
	) {
		sendJson(res, 400, {
			error: `storyParts must contain 2-${READING_STORY_MAX_PARTS} non-empty strings.`,
		});
		return;
	}
	if (typeof body.languageFocus !== "string" || !body.languageFocus.trim()) {
		sendJson(res, 400, { error: "languageFocus must be a non-empty string." });
		return;
	}
	const generationBrief =
		body.generationBrief === undefined
			? undefined
			: parseNextStoryBrief(body.generationBrief);
	if (body.generationBrief !== undefined && !generationBrief) {
		sendJson(res, 400, {
			error: "generationBrief must be a valid story brief.",
		});
		return;
	}
	if (
		!Array.isArray(body.learnerQuestions) ||
		body.learnerQuestions.some((question) => typeof question !== "string")
	) {
		sendJson(res, 400, {
			error: "learnerQuestions must be an array of strings.",
		});
		return;
	}
	const invalidRecapResults =
		!Array.isArray(body.recapResults) ||
		body.recapResults.some((result) => {
			return (
				!result ||
				typeof result.type !== "string" ||
				typeof result.label !== "string" ||
				typeof result.attempts !== "number" ||
				!Number.isFinite(result.attempts) ||
				result.attempts < 1
			);
		});
	if (invalidRecapResults) {
		sendJson(res, 400, {
			error: "recapResults must be an array of {type, label, attempts}.",
		});
		return;
	}
	if (body.difficulty !== undefined && !isStoryDifficulty(body.difficulty)) {
		sendJson(res, 400, {
			error: "difficulty must be one of the story difficulty ratings.",
		});
		return;
	}
	if (
		body.practiceRequest !== undefined &&
		typeof body.practiceRequest !== "string"
	) {
		sendJson(res, 400, { error: "practiceRequest must be a string." });
		return;
	}

	const nextStoryBrief = await finalizeStoryEvidence(
		openai,
		{
			genreId: body.genreId,
			storyId: body.storyId,
			storySummary: body.storySummary,
			storyParts: body.storyParts,
			languageFocus: body.languageFocus,
			...(generationBrief ? { generationBrief } : {}),
			learnerQuestions: body.learnerQuestions ?? [],
			recapResults: body.recapResults ?? [],
			difficulty: body.difficulty,
			practiceRequest: body.practiceRequest,
		},
		anthropicKey,
	);
	sendJson(res, 200, { nextStoryBrief });
}

export async function handleLearnerWordLogRequest(
	req: IncomingMessage,
	res: ServerResponse,
) {
	const { genreId, word, storyId } = JSON.parse(await readBody(req));
	if (!isLanguageId(genreId)) {
		sendJson(res, 400, { error: "genreId is invalid." });
		return;
	}
	if (!word || typeof word !== "string") {
		sendJson(res, 400, { error: "word is required." });
		return;
	}
	if (
		storyId !== undefined &&
		(typeof storyId !== "string" || !storyIdPattern.test(storyId))
	) {
		sendJson(res, 400, { error: "storyId must be a valid story ID." });
		return;
	}
	const normalizedWord = word.toLowerCase();
	if (!learnerWordPattern.test(normalizedWord)) {
		sendJson(res, 400, { error: "word contains unsupported characters." });
		return;
	}
	await appendLearnerWordLogEntry(normalizedWord, storyId);
	sendJson(res, 204, null);
}

function storyTextFromMessages(messages: ChatMessage[]) {
	return messages
		.filter((message) => message.role !== "system")
		.map((message) => message.content)
		.join("\n\n")
		.slice(-3000);
}
