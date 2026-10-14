import type { ChatMessage, ReadingStory } from "../ai";
import type { StoryPhase, StorySegment } from "../exercise_screen/types";
import type { Language } from "../languages";
import type { NarrationVoiceId } from "../narrationVoice";
import type { SavedStory } from "../saves";
import type { StoryOpeningAudio } from "../storyAudio";
import type { StoryBackgroundImage } from "../storyBackground";
import type { StoryRecapExerciseResult, StoryRecapLesson } from "../storyRecap";

interface StorySaveSnapshotInput {
	id: string;
	genre: Language;
	title: string;
	messages: ChatMessage[];
	segments: StorySegment[];
	currentTarget: string | null;
	phase: StoryPhase;
	backgroundIntro?: string;
	narrationVoice?: NarrationVoiceId;
	readingStory?: ReadingStory;
	wordTranslations?: Record<string, string>;
	readingPartIndex?: number;
	backgroundImage?: StoryBackgroundImage | null;
	openingAudio?: StoryOpeningAudio | null;
	storyRecapLesson?: StoryRecapLesson | null;
	storyRecapResults?: StoryRecapExerciseResult[];
	storyLearnerQuestions?: string[];
	storyWordLookups?: string[];
	storyFeedback?: string | null;
	storyFeedbackSubmittedAt?: string | null;
}

export function fallbackTitle(selected: Language) {
	return `${selected.label} Story`;
}

export function createSaveId(title?: string) {
	const id = crypto.randomUUID
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const suffix = id.slice(0, 8).toLowerCase();
	const slug = title ? slugify(title) || "story" : "story";
	return `${slug}--${suffix}`;
}

function slugify(value: string) {
	return value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

export function buildStorySaveSnapshot({
	id,
	genre,
	title,
	messages,
	segments,
	currentTarget,
	phase,
	backgroundIntro,
	narrationVoice,
	readingStory,
	wordTranslations,
	readingPartIndex,
	backgroundImage,
	openingAudio,
	storyRecapLesson,
	storyRecapResults,
	storyLearnerQuestions,
	storyWordLookups,
	storyFeedback,
	storyFeedbackSubmittedAt,
}: StorySaveSnapshotInput): Omit<SavedStory, "updatedAt"> {
	return {
		id,
		genreId: genre.id,
		title,
		messages,
		segments,
		currentTarget,
		phase,
		backgroundIntro,
		narrationVoice,
		readingStory,
		wordTranslations,
		readingPartIndex,
		storyRecapLesson: storyRecapLesson ?? undefined,
		storyRecapResults: storyRecapResults ?? undefined,
		storyLearnerQuestions: storyLearnerQuestions ?? undefined,
		storyWordLookups: storyWordLookups ?? undefined,
		storyFeedback: storyFeedback ?? undefined,
		...(backgroundImage ?? undefined),
		...(openingAudio ?? undefined),
		...(storyFeedbackSubmittedAt ? { storyFeedbackSubmittedAt } : {}),
	};
}
