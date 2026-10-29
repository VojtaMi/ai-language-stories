import type { ChatMessage, ReadingStory } from "./ai";
import type { StoryPhase, StorySegment } from "./exercise_screen/types";
import type { LanguageId } from "./languages";
import type { NarrationVoiceId } from "./narrationVoice";
import { localStoryStore } from "./storage/storyStore";
import type { StoryOpeningAudio } from "./storyAudio";
import type { StoryBackgroundImage } from "./storyBackground";
import type { StoryRecapExerciseResult, StoryRecapLesson } from "./storyRecap";

export interface SavedStory
	extends Partial<StoryBackgroundImage>,
		Partial<StoryOpeningAudio> {
	id: string;
	genreId: LanguageId;
	title: string;
	/** Missing only on saves made before creation dates were recorded. */
	createdAt?: string;
	updatedAt: string;
	messages: ChatMessage[];
	segments: StorySegment[];
	currentTarget: string | null;
	phase: StoryPhase;
	backgroundIntro?: string;
	narrationVoice?: NarrationVoiceId;
	/** The whole story this save is a cursor into. */
	readingStory?: ReadingStory;
	/** Contextual glosses for the story's words. */
	wordTranslations?: Record<string, string>;
	readingPartIndex?: number;
	storyRecapLesson?: StoryRecapLesson | null;
	storyRecapResults?: StoryRecapExerciseResult[];
	storyLearnerQuestions?: string[];
	/** Story words the learner tapped for help, in first-tap order. */
	storyWordLookups?: string[];
	storyFeedback?: string | null;
	storyFeedbackSubmittedAt?: string | null;
}

export interface SavedStorySummary {
	id: string;
	genreId: LanguageId;
	title: string;
	createdAt: string;
	updatedAt: string;
	preview: string;
	phase: StoryPhase;
	/** Whether this save is a reading story (has a whole story to cursor into). */
	isReadingStory: boolean;
	/** A reading story saved in an older format; see `isSupportedReadingStory`. */
	isOutdatedReadingStory: boolean;
}

export async function listSavedStories(
	genreId?: LanguageId,
): Promise<SavedStorySummary[]> {
	return localStoryStore.list(genreId);
}

/**
 * The one reading-story save, if any, that hasn't reached "finished" yet. At
 * most one can exist at a time: a reading story is only ever started by
 * consuming the prepared queue, and the queue only refills once the previous
 * story is finished and finalized. A save in an older format cannot be
 * continued, so it is not counted and never blocks a new story.
 */
export function findUnfinishedReadingSave(
	saves: SavedStorySummary[],
): SavedStorySummary | null {
	return (
		saves.find(
			(save) =>
				save.isReadingStory &&
				!save.isOutdatedReadingStory &&
				save.phase !== "finished",
		) ?? null
	);
}

export async function loadSavedStory(id: string): Promise<SavedStory> {
	const story = await localStoryStore.get(id);
	if (!story) throw new Error("That story is not available in this browser.");
	return story;
}

/**
 * Fold a section's narration or image into the stored save, leaving every other
 * field as it was found.
 *
 * Media arrives whenever it finishes — which, for media prepared with the story,
 * can be the same tick the story starts. Authoring a whole save from session
 * state at that moment snapshots values that have not settled yet, and the write
 * lands on top of the real one: that is how a live reading story was overwritten
 * with an empty `phase: "loading"` save it could never resume from. What arrived
 * is the only thing this knows to be true, so it is the only thing it writes.
 */
export async function saveStoryMedia(
	id: string,
	media: Partial<StoryBackgroundImage> & Partial<StoryOpeningAudio>,
): Promise<SavedStory> {
	const story = await localStoryStore.patch(id, media);
	if (!story) throw new Error("That story is not available in this browser.");
	return story;
}

export async function saveStory(story: SavedStory): Promise<SavedStory> {
	return localStoryStore.save(story);
}

export async function deleteSavedStory(id: string): Promise<void> {
	return localStoryStore.delete(id);
}
