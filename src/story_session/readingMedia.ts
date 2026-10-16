import type { Language } from "../languages";
import type { NarrationVoiceId } from "../narrationVoice";
import type { SectionDialogue } from "../reading_story/dialogue";
import type { StoryOpeningAudio } from "../storyAudio";
import type { StoryBackgroundImage } from "../storyBackground";
import { shouldGenerateReadingBackground } from "./background";

export interface ReadingMediaSection {
	storyId: string;
	partIndex: number;
	narrationVoice: NarrationVoiceId;
	text: string;
	/** The dominant-action description the background image depicts; narration still uses `text`. */
	imagePrompt: string;
	genre: Language;
	visualContext: string;
	/** Attributed speech for voicing this section per character. */
	dialogue?: SectionDialogue;
}

export interface ReadingSectionMedia {
	openingAudio: StoryOpeningAudio | null;
	backgroundImage: StoryBackgroundImage | null;
}

export interface ReadingMediaGenerators {
	generateAudio(
		section: ReadingMediaSection,
	): Promise<StoryOpeningAudio | null>;
	generateBackground(
		section: ReadingMediaSection,
	): Promise<StoryBackgroundImage | null>;
}

/**
 * The one owner of a reading story's narration and background images.
 *
 * Every path that wants a section's media — preparing the next section, landing
 * on a section whose media never arrived, resuming a save — goes through here,
 * so a section is only ever generated once. Media already in hand (the queued
 * story's part 1, images the story has generated in an earlier session) is
 * seeded in and handed straight back; requests that arrive while a section is
 * still generating join that promise instead of starting a second provider call.
 */
export function createReadingMedia(generators: ReadingMediaGenerators) {
	const audio = new Map<string, Promise<StoryOpeningAudio | null>>();
	const backgrounds = new Map<string, Promise<StoryBackgroundImage | null>>();

	const audioKey = (section: ReadingMediaSection) =>
		`${section.storyId}\n${section.partIndex}\n${section.narrationVoice}\n${section.text}`;
	const backgroundKey = (section: ReadingMediaSection) =>
		`${section.storyId}\n${section.partIndex}\n${section.text}`;

	function share<T>(
		cache: Map<string, Promise<T | null>>,
		key: string,
		label: string,
		start: () => Promise<T | null>,
	): Promise<T | null> {
		const existing = cache.get(key);
		if (existing) return existing;
		const request = start().catch((err) => {
			// Media is never allowed to break reading, and a failure is not an
			// answer: forget it, so a later arrival at this section can try again.
			console.warn(`Could not prepare reading ${label}.`, err);
			cache.delete(key);
			return null;
		});
		cache.set(key, request);
		return request;
	}

	return {
		/** Records media that already exists, so it is never generated again. */
		seed(
			section: ReadingMediaSection,
			media: Partial<ReadingSectionMedia>,
		): void {
			if (media.openingAudio !== undefined) {
				audio.set(audioKey(section), Promise.resolve(media.openingAudio));
			}
			if (media.backgroundImage !== undefined) {
				backgrounds.set(
					backgroundKey(section),
					Promise.resolve(media.backgroundImage),
				);
			}
		},

		requestAudio(
			section: ReadingMediaSection,
		): Promise<StoryOpeningAudio | null> {
			return share(audio, audioKey(section), "narration", () =>
				generators.generateAudio(section),
			);
		},

		/** Resolves to null where the cadence gives a section no image of its own. */
		requestBackground(
			section: ReadingMediaSection,
		): Promise<StoryBackgroundImage | null> {
			if (!shouldGenerateReadingBackground(section.partIndex)) {
				return Promise.resolve(null);
			}
			return share(
				backgrounds,
				backgroundKey(section),
				"background image",
				() => generators.generateBackground(section),
			);
		},

		/** Warms everything a section needs, so arriving at it costs nothing. */
		async prepare(section: ReadingMediaSection): Promise<ReadingSectionMedia> {
			const [openingAudio, backgroundImage] = await Promise.all([
				this.requestAudio(section),
				this.requestBackground(section),
			]);
			return { openingAudio, backgroundImage };
		},

		/** Drops everything: a different story's media is never reusable. */
		reset(): void {
			audio.clear();
			backgrounds.clear();
		},
	};
}

export type ReadingMedia = ReturnType<typeof createReadingMedia>;
