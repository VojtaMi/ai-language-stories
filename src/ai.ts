import { getLanguage, type Language, type LanguageId } from "./languages";
import type { LearnerContext } from "./learnerContext";
import type { LearnerPreferences } from "./learnerState";
import { DEFAULT_LEARNER_CONTEXT, parseLearnerContext } from "./learnerState";
import {
	DEFAULT_TEXT_MODEL,
	EXERCISE_MODEL,
	STORY_SEGMENT_MAX_TOKENS,
	type TextModelId,
	type TextReasoningEffort,
} from "./models";
import type { NarrationVoiceId } from "./narrationVoice";
import type { NextStoryBrief } from "./nextStoryBrief";
import type { ProviderAvailability } from "./providerAvailability";
import type { ChatMessage, ReadingStory, ReadingStoryPart } from "./story";
import type { StoryOpeningAudio } from "./storyAudio";
import type { StoryBackgroundImage } from "./storyBackground";
import type { StoryDifficulty } from "./storyFeedback";
import {
	buildStoryRecapPrompt,
	parseStoryRecapLesson,
	type StoryRecapExerciseResult,
	type StoryRecapLesson,
} from "./storyRecap";
import type { TtsModelId } from "./ttsModel";

export type { ChatMessage, ReadingStory, ReadingStoryPart };

const STORY_RECAP_MAX_TOKENS = 900;

export async function fetchProviderAvailability(): Promise<ProviderAvailability> {
	const res = await fetch("/api/provider-availability");
	if (!res.ok)
		throw new Error(`Provider availability request failed: ${res.status}`);
	return (await res.json()) as ProviderAvailability;
}

export type LanguageTutorChatMessage = {
	role: "user" | "assistant";
	content: string;
};

interface LanguageTutorRequest {
	language: Language;
	segments: Array<{ author: "ai" | "user"; text: string }>;
	currentTarget: string | null;
	backgroundIntro?: string;
	conversation: LanguageTutorChatMessage[];
	question: string;
	model?: TextModelId;
}

/**
 * POSTs `body` as JSON to an app endpoint. `label` names the operation in the
 * thrown error, which reaches the learner as a message (e.g. "Translation
 * request failed: 503").
 */
async function post(
	url: string,
	body: unknown,
	label: string,
): Promise<Response> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		let detail = `${res.status}`;
		try {
			const body = (await res.json()) as { error?: unknown };
			if (typeof body.error === "string" && body.error.trim()) {
				detail = body.error;
			}
		} catch {
			// Keep the status when the server did not return JSON.
		}
		throw new Error(`${label} failed: ${detail}`);
	}
	return res;
}

/** {@link post}, then parses the JSON reply. */
async function postJson<T>(
	url: string,
	body: unknown,
	label: string,
): Promise<T> {
	const res = await post(url, body, label);
	return (await res.json()) as T;
}

async function complete(
	messages: ChatMessage[],
	model: TextModelId,
	maxTokens = STORY_SEGMENT_MAX_TOKENS,
	responseFormat: "text" | "json" = "text",
	reasoningEffort?: TextReasoningEffort,
): Promise<string> {
	const { text } = await postJson<{ text?: string }>(
		"/api/ai/complete",
		{ messages, maxTokens, model, responseFormat, reasoningEffort },
		"AI request",
	);
	if (!text) throw new Error("The AI returned an empty response.");
	return text;
}

let learnerContextPromise: Promise<LearnerContext> | null = null;

/** Drops cached learner settings so the next read refetches them. */
export function invalidateLearnerProfile() {
	learnerContextPromise = null;
}

async function fetchLearnerContext(): Promise<LearnerContext> {
	if (!learnerContextPromise) {
		learnerContextPromise = (async () => {
			const res = await fetch("/api/learner-profile");
			if (!res.ok) throw new Error(`Profile request failed: ${res.status}`);
			const context = parseLearnerContext(await res.json());
			if (!context) throw new Error("Profile response has an invalid shape.");
			return context;
		})();
	}

	try {
		return await learnerContextPromise;
	} catch {
		learnerContextPromise = null;
		return structuredClone(DEFAULT_LEARNER_CONTEXT);
	}
}

export async function fetchLearnerPreferences(): Promise<LearnerPreferences> {
	return (await fetchLearnerContext()).preferences;
}

export async function updateLearnerPreferences(
	preferences: Pick<LearnerPreferences, "prefer" | "avoid">,
): Promise<LearnerPreferences> {
	const response = await fetch("/api/learner-profile/preferences", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(preferences),
	});
	if (!response.ok) throw new Error(await response.text());
	invalidateLearnerProfile();
	return (await response.json()) as LearnerPreferences;
}

/**
 * Folds evidence into the learner handout. Fire-and-forget: refining must never
 * disrupt the learner's flow, so all failures are swallowed and the handout
 * stays as it was. Invalidates on both sides of the request so a read racing it
 * cannot leave a stale profile cached.
 */
async function refineLearnerProfile(
	endpoint: string,
	evidence: unknown,
): Promise<void> {
	try {
		invalidateLearnerProfile();
		await post(`/api/learner-profile/${endpoint}`, evidence, "Profile refine");
		invalidateLearnerProfile();
	} catch {
		// Fire-and-forget: the handout simply stays as it was.
	}
}

export interface StoryFinishEvidence {
	genreId: LanguageId;
	storyId: string;
	storySummary: string;
	/** Complete prose lets finalization choose grounded complexity examples. */
	storyParts: string[];
	/** The primary language focus this story targeted; the chain advance/reinforce signal depends on it. */
	languageFocus: string;
	/** Validated authoring state retained with the story for handoff recovery. */
	generationBrief?: NextStoryBrief;
	learnerQuestions?: string[];
	recapResults: StoryRecapExerciseResult[];
	/** How hard the story felt, on the 5-point scale the completion form offers. */
	difficulty?: StoryDifficulty;
	/** The learner's own words about what felt hard or what to practice next. */
	practiceRequest?: string;
}

/**
 * Baseline finalization for a just-finished reading story: folds the story
 * summary/character/setting, this story's word lookups (aggregated server-side),
 * and the learner's buffered tutor questions into the handout. Idempotent on the
 * server, so calling it more than once for a story is safe.
 */
export async function finalizeReadingStoryEvidence(
	evidence: StoryFinishEvidence,
): Promise<void> {
	return refineLearnerProfile("finalize-story", evidence);
}

interface GenerateStoryRecapLessonInput {
	genreId: LanguageId;
	storyParts: string[];
	languageFocuses: string[];
	wordTranslations: Record<string, string>;
}

export async function generateStoryRecapLesson(
	input: GenerateStoryRecapLessonInput,
	model: TextModelId = EXERCISE_MODEL,
): Promise<StoryRecapLesson> {
	const genre = getLanguage(input.genreId);
	const text = await complete(
		[
			{
				role: "system",
				content: buildStoryRecapPrompt(input.languageFocuses[0], genre),
			},
			{
				role: "user",
				content: [
					"Finished reading story:",
					input.storyParts
						.map((part, index) => `Part ${index + 1}: ${part}`)
						.join("\n\n"),
					"",
					"Language focuses:",
					input.languageFocuses.join("\n"),
					"",
					"Available word translations:",
					JSON.stringify(input.wordTranslations, null, 2),
				].join("\n"),
			},
		],
		model,
		STORY_RECAP_MAX_TOKENS,
		"json",
	);
	return parseStoryRecapLesson(text, genre);
}

export async function generateStoryBackgroundImage(
	genreId: LanguageId,
	messages: ChatMessage[],
	storyId: string,
	options: {
		sectionIndex?: number;
		visualContext?: string;
		anchorToFirstSection?: boolean;
	} = {},
): Promise<StoryBackgroundImage> {
	return postJson<StoryBackgroundImage>(
		"/api/ai/background-image",
		{ genreId, messages, storyId, ...options },
		"Image request",
	);
}

export async function generateOpeningAudio(
	genreId: LanguageId,
	text: string,
	storyId: string,
	narrationVoice: NarrationVoiceId,
	options: { sectionIndex?: number; ttsModel?: TtsModelId } = {},
): Promise<StoryOpeningAudio> {
	return postJson<StoryOpeningAudio>(
		"/api/ai/opening-audio",
		{ genreId, text, storyId, narrationVoice, ...options },
		"Opening audio request",
	);
}

export async function getWordAudioUrl(
	genreId: LanguageId,
	word: string,
): Promise<string> {
	const body = await postJson<{ url: string }>(
		"/api/word-audio",
		{ genreId, word },
		"Word audio request",
	);
	return body.url;
}

export async function logLearnerWordClick(
	genreId: LanguageId,
	word: string,
	storyId?: string,
): Promise<void> {
	try {
		await fetch("/api/learner-profile/word-log", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ genreId, word, ...(storyId ? { storyId } : {}) }),
		});
	} catch {
		// Learning signals should never interrupt reading.
	}
}

export async function regenerateWordAudioUrl(
	genreId: LanguageId,
	word: string,
): Promise<string> {
	const body = await postJson<{ url: string }>(
		"/api/word-audio/regenerate",
		{ genreId, word },
		"Word audio regenerate",
	);
	return body.url;
}

export async function regenerateWordTranslation(
	genreId: LanguageId,
	word: string,
	storyContext?: string,
): Promise<string | null> {
	const body = await postJson<{ translation: string | null }>(
		"/api/ai/translate-words/regenerate",
		{ genreId, word, storyContext },
		"Regenerate request",
	);
	return body.translation;
}

export async function askLanguageTutor({
	language,
	segments,
	currentTarget,
	backgroundIntro,
	conversation,
	question,
	model = DEFAULT_TEXT_MODEL,
}: LanguageTutorRequest): Promise<string> {
	const storyContext = [
		backgroundIntro ? `Player context: ${backgroundIntro}` : "",
		segments.length > 0
			? `Completed story segments:\n${segments
					.map((segment) =>
						segment.author === "ai"
							? `Story text: ${segment.text}`
							: `Learner continuation: ${segment.text}`,
					)
					.join("\n\n")}`
			: "",
		currentTarget ? `Current reading passage:\n${currentTarget}` : "",
	]
		.filter(Boolean)
		.join("\n\n")
		.slice(-6000);

	const messages: ChatMessage[] = [
		{
			role: "system",
			content:
				`You are ${language.label} Bot, a friendly tutor inside a ${language.label} reading story. ` +
				`Explain ${language.label} clearly and practically: ${language.teachingTopics}. ` +
				"Use the provided story context when it helps. Do not continue or rewrite the story unless the learner asks for that. " +
				"If the learner asks for an exercise answer, prefer a helpful hint and explanation before giving the full answer. " +
				"Reply in the language the learner uses for their latest message. If their message is mixed or ambiguous, reply in English. " +
				`Use simple ${language.label} when replying in ${language.label}. Keep answers concise, warm, and easy for a beginner to act on. ` +
				"Default to 2-5 short sentences. Use plain text suitable for a small chat panel. " +
				"Do not use Markdown tables, headings, horizontal rules, or long lists. If the learner explicitly asks for more detail, you may give a longer answer, but keep the formatting simple.",
		},
		{
			role: "user",
			content: `Story context for this tutoring session:\n${
				storyContext || "No story text is available yet."
			}`,
		},
		...conversation.map((message) => ({
			role: message.role,
			content: message.content,
		})),
		{ role: "user", content: question },
	];

	return complete(messages, model, 520);
}
