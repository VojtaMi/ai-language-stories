import {
	type Language,
	languageStorySystemPrompt,
	starterBriefForLanguage,
} from "./languages";
import type { LearnerPreferences, RecentStoryMemory } from "./learnerState";
import type { TextModelId, TextReasoningEffort } from "./models";
import type { NextStoryBrief } from "./nextStoryBrief";
import type { DialogueLine, StoryCharacter } from "./reading_story/dialogue";
import { generateReadingManuscript } from "./reading_story/manuscript";
import { proofreadReadingManuscript } from "./reading_story/proofread";
import {
	READING_STORY_MAX_PARTS,
	splitReadingManuscript,
} from "./reading_story/split";
import { generateReadingVisualPlan } from "./reading_story/visualPlan";
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
 * A complete reading story. Plot review, prose authoring, proofreading, semantic splitting,
 * and visual planning all finish before it exists, so the session only moves a
 * cursor through `parts` and never generates prose again.
 */
export interface ReadingStory {
	title: string;
	storySummary: string;
	languageFocus: string;
	/** The validated handoff used to generate this story; recovery reuses it if the next handoff is malformed. */
	generationBrief?: NextStoryBrief;
	/** Shared identity, location, and recurring-object context for every image. */
	visualContext: string;
	/** Character and place names excluded from vocabulary translation. */
	properNames: string[];
	/** One dominant-action image prompt per pair of parts, in narrative order. */
	imagePrompts: string[];
	parts: ReadingStoryPart[];
	/**
	 * Speaking characters and one attribution per dialogue quotation across all
	 * parts, in order. Absent on stories written before dialogue was voiced.
	 */
	characters?: StoryCharacter[];
	dialogue?: DialogueLine[];
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

/** Hidden image-generation context that keeps the character and place stable across sections. */
export function readingVisualContext(story: ReadingStory): string {
	return story.visualContext;
}

/**
 * The image prompt for the section at `partIndex` (1-based). One image covers a
 * pair of parts, so parts 1-2 share prompt 0, 3-4 prompt 1, 5-6 prompt 2. This
 * is the dominant action the image should depict; the stable character identity
 * is supplied separately by {@link readingVisualContext}.
 */
export function readingImagePrompt(
	story: ReadingStory,
	partIndex: number,
): string {
	return story.imagePrompts[Math.floor((partIndex - 1) / 2)];
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
	} = {},
): Promise<ReadingStory> {
	const nextStoryBrief =
		options.nextStoryBrief ?? starterBriefForLanguage(genre);
	const explicitTheme = nextTheme?.trim().slice(0, NEXT_THEME_MAX_CHARS) ?? "";
	const storySubject = explicitTheme || nextStoryBrief.themeSuggestion;
	const storyPlot = await prepareReadingStoryPlot(
		complete,
		storySubject || undefined,
		preferences,
		nextStoryBrief.narrativeScale,
		options.recentStories,
		genre,
		nextStoryBrief.language.focus,
	);
	const draftManuscript = await generateReadingManuscript(
		complete,
		genre,
		storyPlot,
		nextStoryBrief,
		preferences,
		options.reasoningEffort ?? "low",
	);
	const manuscript = await proofreadReadingManuscript(
		complete,
		draftManuscript,
		genre,
	);
	const parts = await splitReadingManuscript(complete, manuscript, genre);
	const visualPlan = await generateReadingVisualPlan(complete, parts, genre);
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
	const visualContext = requiredStoryField(
		parsed.visualContext,
		"visualContext",
	);
	const properNames = requiredStringArray(parsed.properNames, "properNames");
	const imagePrompts = requiredStringArray(parsed.imagePrompts, "imagePrompts");
	const imageCount = Math.ceil(parsed.parts.length / 2);
	if (imagePrompts.length !== imageCount) {
		throw new Error(
			`The reading story has ${imagePrompts.length} image prompts instead of ${imageCount}.`,
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
		visualContext,
		properNames,
		imagePrompts,
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
