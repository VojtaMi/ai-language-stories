/** Curated models for the interactive language tutor. */
export const CHAT_MODELS = [
	{ id: "gpt-6-luna", label: "GPT 6 Luna" },
	{ id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
	{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
] as const;

export type ChatModelId = (typeof CHAT_MODELS)[number]["id"];

export const TEXT_MODELS = [
	...CHAT_MODELS,
	{ id: "gpt-6-sol", label: "GPT 6 Sol" },
	{ id: "gpt-5.6-sol", label: "GPT 5.6 Sol" },
	{ id: "gpt-5.6-terra", label: "GPT 5.6 Terra" },
	{ id: "gpt-5.6-luna", label: "GPT 5.6 Luna" },
	{ id: "gpt-5.4-mini", label: "GPT 5.4 mini" },
	{ id: "gpt-5.4", label: "GPT 5.4" },
	{ id: "gpt-5.5", label: "GPT 5.5" },
	{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
	{ id: "claude-sonnet-5", label: "Claude Sonnet 5" },
	{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
	{ id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
	{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
	{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
] as const;

export type TextModelId = (typeof TEXT_MODELS)[number]["id"];

export function isTextModelId(value: unknown): value is TextModelId {
	return TEXT_MODELS.some((model) => model.id === value);
}
export const DEFAULT_TEXT_MODEL: TextModelId = "gpt-5.6-luna";

export const TEXT_REASONING_EFFORTS = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
export type TextReasoningEffort = (typeof TEXT_REASONING_EFFORTS)[number];

export type AiPreset = Readonly<{
	model: TextModelId;
	reasoningEffort: TextReasoningEffort;
}>;

/**
 * Curated story-generation choices. The CLI uses TEXT_MODELS;
 * this shorter list only exposes combinations we have evaluated for complete
 * reading stories. Typing stories use the preset's model but do not use its
 * reasoning effort because their continuation endpoint streams plain text.
 */
export const STORY_GENERATION_PRESETS = [
	{
		id: "terra-medium",
		label: "GPT 5.6 Terra · Medium",
		model: "gpt-5.6-terra",
		reasoningEffort: "medium",
	},
	{
		id: "terra-low",
		label: "GPT 5.6 Terra · Low",
		model: "gpt-5.6-terra",
		reasoningEffort: "low",
	},
	{
		id: "luna-low",
		label: "GPT 5.6 Luna · Low",
		model: "gpt-5.6-luna",
		reasoningEffort: "low",
	},
	// Compared on 27 manuscripts (eo/de/la, 2026-10-14): judged quality on par
	// with GPT 5.6 Luna at under half the cost, slightly weaker on grammar,
	// which the proofreading stage covers.
	{
		id: "luna6-low",
		label: "GPT 6 Luna · Low",
		model: "gpt-6-luna",
		reasoningEffort: "low",
	},
] as const satisfies readonly {
	id: string;
	label: string;
	model: TextModelId;
	reasoningEffort: TextReasoningEffort;
}[];

export type StoryGenerationPreset = (typeof STORY_GENERATION_PRESETS)[number];
export type StoryGenerationPresetId = StoryGenerationPreset["id"];
export const DEFAULT_STORY_GENERATION_PRESET_ID: StoryGenerationPresetId =
	"luna-low";

export function findStoryGenerationPreset(
	id: string | null | undefined,
): StoryGenerationPreset | undefined {
	return STORY_GENERATION_PRESETS.find((preset) => preset.id === id);
}

export function getStoryGenerationPreset(
	id: StoryGenerationPresetId,
): StoryGenerationPreset {
	return findStoryGenerationPreset(id) ?? STORY_GENERATION_PRESETS[0];
}

/**
 * Default model for the language tutor chat. The bot answers short, interactive
 * follow-up questions where latency is felt directly, so it defaults
 * independently of the story-generation model. Users can switch it in
 * the chat UI; the choice persists separately from the story model.
 */
export const DEFAULT_CHAT_MODEL: ChatModelId = "gpt-6-luna";

/**
 * Token ceiling for a single story segment. This is a safety net, not a length
 * target: the prompt asks for 2-4 sentences (well under this), so a well-formed
 * segment finishes naturally before reaching it. Keeping the ceiling comfortably
 * above the intended length is what stops `max_tokens` from truncating prose
 * mid-sentence.
 */
export const STORY_SEGMENT_MAX_TOKENS = 400;

/**
 * Token ceiling for the structured manuscript-authoring call of one complete
 * reading story. On reasoning models this also covers reasoning tokens. It is
 * deliberately a ceiling rather than a length target; narrative scale in the
 * authoring data controls the finished prose length.
 */
export const READING_STORY_MAX_TOKENS = 8000;

/**
 * Model for generated end-of-story exercises (the recap lesson) — not
 * user-selectable. Exercises are small structured tasks, not prose, so they are
 * deliberately decoupled from the user-selected story-generation preset: a
 * beginner recap needs neither the prose-tier model nor the reasoning effort a
 * full reading manuscript does. Tune this independently of the story preset.
 */
export const EXERCISE_MODEL: TextModelId = "gpt-5.6-luna";

/**
 * Preset for bounded internal structured tasks such as learner-state
 * maintenance and reading-story repair. It is not user-selectable.
 */
export const SYSTEM_AI_PRESET = {
	model: "gpt-5.6-luna",
	reasoningEffort: "none",
} as const satisfies AiPreset;
