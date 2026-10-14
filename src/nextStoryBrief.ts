export const STORY_PROGRESSIONS = [
	"establish",
	"reinforce",
	"advance",
] as const;
export type StoryProgression = (typeof STORY_PROGRESSIONS)[number];

export const STORY_COMPLEXITIES = [
	"absolute beginner",
	"simpler",
	"similar",
	"harder",
] as const;
export type StoryComplexity = (typeof STORY_COMPLEXITIES)[number];

export const NARRATIVE_SCALES = ["minimal", "simple"] as const;
export type NarrativeScale = (typeof NARRATIVE_SCALES)[number];

export interface NextStoryBrief {
	themeSuggestion: string;
	narrativeScale: NarrativeScale;
	language: {
		focus: string;
		progression: StoryProgression;
		complexity: StoryComplexity;
		calibrationSnippets: string[];
	};
}

export const STARTER_NEXT_STORY_BRIEF: NextStoryBrief = {
	themeSuggestion: "",
	narrativeScale: "minimal",
	language: {
		focus:
			"Simple present-tense sentences with concrete beginner words, mostly singular; a few simple direct objects with -n are fine where the story needs them.",
		progression: "establish",
		complexity: "absolute beginner",
		calibrationSnippets: [
			"Petro estas viro. Petro sidas en ĝardeno. Simo estas hundo. Petro vidas la hundon. Simo dormas apud Petro.",
		],
	},
};

const BRIEF_KEYS = ["themeSuggestion", "narrativeScale", "language"] as const;
const LANGUAGE_KEYS = [
	"focus",
	"progression",
	"complexity",
	"calibrationSnippets",
] as const;

export function parseNextStoryBrief(value: unknown): NextStoryBrief | null {
	if (!isExactObject(value, BRIEF_KEYS)) return null;
	if (!isExactObject(value.language, LANGUAGE_KEYS)) return null;

	const themeSuggestion = boundedString(value.themeSuggestion, 120, true);
	const focus = boundedString(value.language.focus, 300);
	const snippets = value.language.calibrationSnippets;
	if (
		themeSuggestion === null ||
		!NARRATIVE_SCALES.includes(value.narrativeScale as NarrativeScale) ||
		focus === null ||
		!STORY_PROGRESSIONS.includes(
			value.language.progression as StoryProgression,
		) ||
		!STORY_COMPLEXITIES.includes(
			value.language.complexity as StoryComplexity,
		) ||
		!Array.isArray(snippets) ||
		snippets.length > 2
	) {
		return null;
	}

	const calibrationSnippets = snippets.map((snippet) =>
		boundedString(snippet, 600),
	);
	if (calibrationSnippets.some((snippet) => snippet === null)) return null;

	return {
		themeSuggestion,
		narrativeScale: value.narrativeScale as NarrativeScale,
		language: {
			focus,
			progression: value.language.progression as StoryProgression,
			complexity: value.language.complexity as StoryComplexity,
			calibrationSnippets: calibrationSnippets as string[],
		},
	};
}

function boundedString(
	value: unknown,
	maxLength: number,
	allowEmpty = false,
): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if ((!allowEmpty && !trimmed) || trimmed.length > maxLength) return null;
	return trimmed;
}

function isExactObject<const Keys extends readonly string[]>(
	value: unknown,
	keys: Keys,
): value is Record<Keys[number], unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value);
	return (
		actual.length === keys.length && actual.every((key) => keys.includes(key))
	);
}
