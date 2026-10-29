import {
	type Language,
	languageStorySystemPrompt,
	starterBriefForLanguage,
} from "./languages";
import type { LearnerPreferences, RecentStoryMemory } from "./learnerState";
import type { TextModelId, TextReasoningEffort } from "./models";
import type { NextStoryBrief } from "./nextStoryBrief";
import type { DialogueLine, StoryCharacter } from "./reading_story/dialogue";
import { checkReadingManuscriptLogic } from "./reading_story/logicCheck";
import { generateReadingManuscript } from "./reading_story/manuscript";
import {
	type ManuscriptReview,
	proofreadReadingManuscript,
} from "./reading_story/proofread";
import {
	READING_STORY_MAX_PARTS,
	splitReadingManuscript,
} from "./reading_story/split";
import {
	generateReadingVisualPlan,
	imageVisualContext,
	parseImageScene,
	parseVisualElements,
	type ReadingImageScene,
	type ReadingVisualElement,
	readingImageIndex,
	readingImageParts,
} from "./reading_story/visualPlan";
import { prepareReadingStoryPlot } from "./readingStoryPlot";

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

/** One presentation section of the immutable finished prose the learner reads. */
export interface ReadingStoryPart {
	text: string;
}

/**
 * A complete reading story. Plot review, prose authoring, logic check, proofreading, semantic splitting,
 * and visual planning all finish before it exists, so the session only moves a
 * cursor through `parts` and never generates prose again.
 */
export interface ReadingStory {
	title: string;
	storySummary: string;
	languageFocus: string;
	/** The validated handoff used to generate this story; recovery reuses it if the next handoff is malformed. */
	generationBrief?: NextStoryBrief;
	/** Recurring characters, places, and objects, described once for every image. */
	visualElements: ReadingVisualElement[];
	/** Character and place names excluded from vocabulary translation. */
	properNames: string[];
	/** One scene per image part, in narrative order; see {@link readingImageParts}. */
	imageScenes: ReadingImageScene[];
	parts: ReadingStoryPart[];
	/**
	 * Speaking characters and one attribution per dialogue quotation across all
	 * parts, in order. Absent on stories written before dialogue was voiced.
	 */
	characters?: StoryCharacter[];
	dialogue?: DialogueLine[];
}

/**
 * The intermediate results that shaped a story, kept beside it for diagnosis:
 * a finished story alone does not show which pass introduced or missed a flaw.
 */
export interface ReadingStoryGenerationLog {
	plotDraft: string;
	plotRevised: boolean;
	plot: string;
	draftText: string;
	logicCheck: ManuscriptReview;
	proofread: ManuscriptReview;
}

/**
 * Runs one non-streaming completion. Each call site supplies its own transport:
 * an HTTP fetch from the browser, an in-process call from the CLI.
 */
export type Complete = (
	messages: ChatMessage[],
	maxTokens: number,
	options?: {
		reasoningEffort?: TextReasoningEffort;
		model?: TextModelId;
	},
) => Promise<string>;

const NEXT_THEME_MAX_CHARS = 240;

/**
 * The chat history a reading story carries once `partIndex` parts have been
 * revealed. It records the prose already shown for persistence and tutor context.
 */
export function readingStoryMessages(
	genre: Language,
	story: ReadingStory,
	partIndex: number,
): ChatMessage[] {
	return [
		{ role: "system", content: languageStorySystemPrompt(genre) },
		...story.parts
			.slice(0, partIndex)
			.map((part): ChatMessage => ({ role: "assistant", content: part.text })),
	];
}

function readingImageScene(
	story: ReadingStory,
	partIndex: number,
): ReadingImageScene {
	return story.imageScenes[readingImageIndex(partIndex, story.parts.length)];
}

/**
 * Hidden image-generation context for the section at `partIndex` (1-based):
 * the appearance of only the elements present in its image, so identities stay
 * stable without objects leaking into moments they are not part of.
 */
export function readingVisualContext(
	story: ReadingStory,
	partIndex: number,
): string {
	return imageVisualContext(
		story.visualElements,
		readingImageScene(story, partIndex),
	);
}

/**
 * The image prompt for the section at `partIndex` (1-based): the image of the
 * nearest image part at or before it (see {@link readingImageParts}). This is
 * the dominant action the image should depict; the stable identities are
 * supplied separately by {@link readingVisualContext}.
 */
export function readingImagePrompt(
	story: ReadingStory,
	partIndex: number,
): string {
	return readingImageScene(story, partIndex).prompt;
}

/** Compact English context retained with the finished story for audit and finalization. */
export function readingStorySummary(story: ReadingStory): string {
	return story.storySummary;
}

export async function generateReadingStory(
	complete: Complete,
	genre: Language,
	preferences?: Pick<LearnerPreferences, "prefer" | "avoid">,
	nextTheme?: string,
	options: {
		reasoningEffort?: TextReasoningEffort;
		nextStoryBrief?: NextStoryBrief;
		recentStories?: RecentStoryMemory[];
		onGenerationLog?: (log: ReadingStoryGenerationLog) => void;
	} = {},
): Promise<ReadingStory> {
	const nextStoryBrief =
		options.nextStoryBrief ?? starterBriefForLanguage(genre);
	const explicitTheme = nextTheme?.trim().slice(0, NEXT_THEME_MAX_CHARS) ?? "";
	const storySubject = explicitTheme || nextStoryBrief.themeSuggestion;
	const plotResult = await prepareReadingStoryPlot(
		complete,
		storySubject || undefined,
		preferences,
		nextStoryBrief.narrativeScale,
		options.recentStories,
		genre,
		nextStoryBrief.language.focus,
	);
	const storyPlot = plotResult.plot;
	const draftManuscript = await generateReadingManuscript(
		complete,
		genre,
		storyPlot,
		nextStoryBrief,
		preferences,
		options.reasoningEffort ?? "low",
	);
	const logicCheck = await checkReadingManuscriptLogic(
		complete,
		draftManuscript,
		genre,
	);
	const proofread = await proofreadReadingManuscript(
		complete,
		logicCheck.manuscript,
		genre,
	);
	const manuscript = proofread.manuscript;
	options.onGenerationLog?.({
		plotDraft: plotResult.draft,
		plotRevised: plotResult.revised,
		plot: storyPlot,
		draftText: draftManuscript.text,
		logicCheck: logicCheck.review,
		proofread: proofread.review,
	});
	const parts = await splitReadingManuscript(complete, manuscript, genre);
	const visualPlan = await generateReadingVisualPlan(
		complete,
		parts,
		manuscript.cast,
		genre,
	);
	return {
		title: manuscript.title,
		storySummary: storyPlot,
		languageFocus: nextStoryBrief.language.focus,
		generationBrief: nextStoryBrief,
		...visualPlan,
		parts,
		characters: manuscript.characters,
		dialogue: manuscript.dialogue,
	};
}

/**
 * Whether a stored story matches the current format, so the reading session can
 * run it end to end. Stories saved before a format change fail it: the prepared
 * queue drops them, and an unfinished save stops blocking a new story.
 */
export function isSupportedReadingStory(story: unknown): story is ReadingStory {
	if (!story || typeof story !== "object") return false;
	const readingStory = story as ReadingStory;
	const parts = readingStory.parts;
	return (
		typeof readingStory.title === "string" &&
		Boolean(readingStory.title.trim()) &&
		typeof readingStory.storySummary === "string" &&
		Boolean(readingStory.storySummary.trim()) &&
		typeof readingStory.languageFocus === "string" &&
		Boolean(readingStory.languageFocus.trim()) &&
		Array.isArray(readingStory.visualElements) &&
		readingStory.visualElements.length > 0 &&
		Array.isArray(parts) &&
		parts.length >= 2 &&
		parts.length <= READING_STORY_MAX_PARTS &&
		parts.every((part) => Boolean(part?.text?.trim())) &&
		Array.isArray(readingStory.properNames) &&
		Array.isArray(readingStory.imageScenes) &&
		readingStory.imageScenes.length ===
			readingImageParts(parts.length).length &&
		readingStory.imageScenes.every(
			(scene) => Array.isArray(scene?.visible) && Boolean(scene.prompt?.trim()),
		)
	);
}

/**
 * Accepts only a story the reading session can run end to end: bounded non-empty
 * parts, one image instruction per pair, and the metadata media and recap need.
 */
export function parseReadingStory(raw: string): ReadingStory {
	const jsonText = extractJsonObject(raw);
	let parsed: Partial<ReadingStory>;
	try {
		parsed = JSON.parse(jsonText) as Partial<ReadingStory>;
	} catch {
		throw new Error("The AI returned an invalid reading story.");
	}

	if (!Array.isArray(parsed.parts)) {
		throw new Error("The AI returned an invalid reading story.");
	}
	if (
		parsed.parts.length < 2 ||
		parsed.parts.length > READING_STORY_MAX_PARTS
	) {
		throw new Error(
			`The reading story has an unsupported ${parsed.parts.length} parts.`,
		);
	}

	const title = requiredStoryField(parsed.title, "title");
	const storySummary = requiredStoryField(parsed.storySummary, "storySummary");
	const languageFocus = requiredStoryField(
		parsed.languageFocus,
		"languageFocus",
	);
	const visualElements = parseVisualElements(parsed.visualElements);
	const properNames = requiredStringArray(parsed.properNames, "properNames");
	const elementNames = visualElements.map((element) => element.name);
	if (!Array.isArray(parsed.imageScenes)) {
		throw new Error("The AI returned a reading story with no imageScenes.");
	}
	const imageScenes = parsed.imageScenes.map((scene) =>
		parseImageScene(scene, elementNames),
	);
	const imageCount = readingImageParts(parsed.parts.length).length;
	if (imageScenes.length !== imageCount) {
		throw new Error(
			`The reading story has ${imageScenes.length} image scenes instead of ${imageCount}.`,
		);
	}

	const parts = parsed.parts.map((part, index) => {
		const label = `part ${index + 1}`;
		if (!part || typeof part !== "object") {
			throw new Error(`The AI returned an invalid reading story ${label}.`);
		}
		return {
			text: requiredStoryField(part.text, `${label} text`),
		};
	});

	return {
		title,
		storySummary,
		languageFocus,
		visualElements,
		properNames,
		imageScenes,
		parts,
	};
}

function requiredStringArray(value: unknown, label: string): string[] {
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || !item.trim())
	) {
		throw new Error(`The AI returned a reading story with invalid ${label}.`);
	}
	return value.map((item) => item.trim());
}

function requiredStoryField(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`The AI returned a reading story with no ${label}.`);
	}
	return value.trim();
}

function extractJsonObject(raw: string): string {
	const trimmed = raw.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
	const candidate = fenced?.[1]?.trim() ?? trimmed;
	const start = candidate.indexOf("{");
	if (start < 0) return candidate;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < candidate.length; index += 1) {
		const character = candidate[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}
		if (character === '"') {
			inString = true;
		} else if (character === "{") {
			depth += 1;
		} else if (character === "}") {
			depth -= 1;
			if (depth === 0) return candidate.slice(start, index + 1);
		}
	}
	return trimmed;
}
