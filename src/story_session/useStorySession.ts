import { useCallback, useEffect, useRef, useState } from "react";
import {
	type ChatMessage,
	generateOpeningAudio,
	generateStoryBackgroundImage,
	generateStoryRecapLesson,
	type ReadingStory,
	regenerateWordTranslation,
} from "../ai";
import type { StoryPhase, StorySegment } from "../exercise_screen/types";
import { listStoryImages } from "../gallery/galleryApi";
import {
	getLanguage,
	type Language,
	languageStorySystemPrompt,
} from "../languages";
import { readSelectedNarrationModel } from "../modelSelection/modelSelectionStore";
import type { StoryGenerationPreset } from "../models";
import {
	DEFAULT_NARRATION_VOICE,
	isNarrationVoiceId,
	type NarrationVoiceId,
	pickRandomNarrationVoice,
} from "../narrationVoice";
import { consumePreparedReadingOpening } from "../openings";
import { loadSavedStory, saveStoryMedia } from "../saves";
import {
	readingImagePrompt,
	readingStoryMessages,
	readingStorySummary,
	readingVisualContext,
} from "../story";
import {
	isStoryOpeningAudioForText,
	type StoryOpeningAudio,
} from "../storyAudio";
import type { StoryBackgroundImage } from "../storyBackground";
import type { StoryFeedbackRecord } from "../storyFeedback";
import type { StoryRecapExerciseResult, StoryRecapLesson } from "../storyRecap";
import {
	backgroundFromOpening,
	buildSectionImageMap,
	fallbackBackgroundImage,
} from "./background";
import { useStoryPersistence } from "./persistence/useStoryPersistence";
import {
	createReadingMedia,
	type ReadingMediaSection,
	type ReadingSectionMedia,
} from "./readingMedia";
import { buildStorySaveSnapshot, fallbackTitle } from "./storySnapshot";
import { useReadingPreparation } from "./useReadingPreparation";
import {
	type ResolvedStoryFeedback,
	useStoryFeedback,
} from "./useStoryFeedback";

// The session only distinguishes "am I on the main menu" from "in a story" from
// "somewhere in the lesson flow" — it never branches on individual lesson views.
type View = "menu" | "story";

interface UseStorySessionOptions {
	language: Language;
	storyGeneration: StoryGenerationPreset;
	view: View;
	/** The unfinished reading-story save, if any — see `findUnfinishedReadingSave`. */
	unfinishedReadingSaveId: string | null;
	onViewChange: (view: View, storyId?: string) => void;
	onSavedStoriesChanged: () => Promise<void>;
	onSavesError: (error: string | null) => void;
}

function describeError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (
		/api key is not configured|environment variable is missing or empty/i.test(
			message,
		)
	) {
		return "AI setup is missing. Add the API key for the selected model to .env.local, then restart the dev server.";
	}
	return `Something went wrong reaching the AI: ${message}`;
}

/** Carries the section's dominant-action image prompt to the background-image endpoint. */
function readingBackgroundMessages(
	selected: Language,
	imagePrompt: string,
): ChatMessage[] {
	return [
		{ role: "system", content: languageStorySystemPrompt(selected) },
		{ role: "assistant", content: imagePrompt },
	];
}

/** Everything the media owner needs to produce one section's narration and image. */
function readingMediaSection(
	selected: Language,
	storyId: string,
	story: ReadingStory,
	partIndex: number,
	narrationVoice: NarrationVoiceId,
): ReadingMediaSection | null {
	const part = story.parts[partIndex - 1];
	if (!part) return null;
	return {
		storyId,
		partIndex,
		narrationVoice,
		text: part.text,
		imagePrompt: readingImagePrompt(story, partIndex),
		genre: selected,
		visualContext: readingVisualContext(story),
	};
}

function completedAiSegment(
	id: number,
	text: string,
	audio: StoryOpeningAudio | null,
): StorySegment {
	return {
		id,
		author: "ai",
		text,
		narrationAudio: isStoryOpeningAudioForText(audio, text) ? audio : undefined,
	};
}

/** Keep buffered tutor questions bounded so the baseline evidence stays small. */
const MAX_BUFFERED_BOT_QUESTIONS = 20;
const MAX_BOT_QUESTION_CHARS = 300;

export function useStorySession({
	language,
	storyGeneration,
	view,
	unfinishedReadingSaveId,
	onViewChange,
	onSavedStoriesChanged,
	onSavesError,
}: UseStorySessionOptions) {
	const [genre, setGenre] = useState<Language | null>(language);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [segments, setSegments] = useState<StorySegment[]>([]);
	const [currentTarget, setCurrentTarget] = useState<string | null>(null);
	const [phase, setPhase] = useState<StoryPhase>("loading");
	const [error, setError] = useState<string | null>(null);
	const [activeSaveId, setActiveSaveId] = useState<string | null>(null);
	const [activeTitle, setActiveTitle] = useState<string | null>(null);
	const [backgroundIntro, setBackgroundIntro] = useState<string | null>(null);
	const [backgroundImage, setBackgroundImage] =
		useState<StoryBackgroundImage | null>(null);
	const [openingAudio, setOpeningAudio] = useState<StoryOpeningAudio | null>(
		null,
	);
	const [openingAudioLoading, setOpeningAudioLoading] = useState(false);
	const [openingAudioError, setOpeningAudioError] = useState(false);
	const [openingAudioRetry, setOpeningAudioRetry] = useState(0);
	const [wordTranslations, setWordTranslations] = useState<Record<
		string,
		string
	> | null>(null);
	const [readingStory, setReadingStory] = useState<ReadingStory | null>(null);
	const [readingPartIndex, setReadingPartIndex] = useState<number | null>(null);
	const [narrationVoice, setNarrationVoice] = useState<NarrationVoiceId>(
		DEFAULT_NARRATION_VOICE,
	);
	const [storyRecapLesson, setStoryRecapLesson] =
		useState<StoryRecapLesson | null>(null);
	const [storyRecapError, setStoryRecapError] = useState<string | null>(null);
	// End-of-story feedback is its own slice: it owns the live form draft, the
	// resolved values, and whether the form is submittable at all. The session
	// keeps only the orchestration around it — persistence and finalization.
	const {
		editable: feedbackEditable,
		feedback: storyFeedback,
		submittedAt: storyFeedbackSubmittedAt,
		reportDraft: handleStoryFeedbackDraftChange,
		submit: submitFeedbackValues,
		resolve: resolveStoryFeedback,
		beginLiveFinish: beginStoryFeedback,
		loadFromSave: loadStoryFeedbackFromSave,
		reset: resetStoryFeedback,
		readSnapshot: readStoryFeedbackSnapshot,
	} = useStoryFeedback();
	const activeSaveIdRef = useRef<string | null>(null);
	const currentTargetRef = useRef<string | null>(null);
	const phaseRef = useRef<StoryPhase>("loading");
	const openingAudioRef = useRef<StoryOpeningAudio | null>(null);
	const readingStoryRef = useRef<ReadingStory | null>(null);
	const readingPartIndexRef = useRef<number | null>(null);
	const narrationVoiceRef = useRef<NarrationVoiceId>(DEFAULT_NARRATION_VOICE);
	const storyRecapLessonRef = useRef<StoryRecapLesson | null>(null);
	const storyRecapResultsRef = useRef<StoryRecapExerciseResult[]>([]);
	// Interactive continuity: the learner's tutor questions asked while reading are
	// buffered here (deduped, bounded) and folded once into the baseline at story
	// end — they stay out of the durable handout until the story finalizes.
	const botQuestionsRef = useRef<string[]>([]);
	// Distinguishes a story that reached "finished" just now, in this session,
	// from one loaded already finished (rereading an old save). Only the former
	// should ever finalize: rereading must not re-finalize or re-trigger
	// preparation against stale, superseded evidence.
	const justFinishedReadingRef = useRef(false);

	// Owns finalize-then-prepare for the next reading story, and the menu's
	// readiness for it.
	const readingPreparation = useReadingPreparation(
		language.id,
		storyGeneration,
		unfinishedReadingSaveId,
		view === "menu",
	);
	const {
		makeNextStory: makeNextReadingStory,
		retry: retryReadingPreparationLifecycle,
		markConsumed: markReadingStoryConsumed,
	} = readingPreparation;

	// The one owner of every reading narration and background image: preparing a
	// section ahead, arriving at it, and recovering it after a reload all ask the
	// same owner, so a section is never generated twice.
	const readingMediaRef = useRef(
		createReadingMedia({
			generateAudio: (section) =>
				generateOpeningAudio(
					section.genre.id,
					section.text,
					section.storyId,
					section.narrationVoice,
					{
						sectionIndex: section.partIndex,
						ttsModel: readSelectedNarrationModel(),
					},
				),
			generateBackground: async (section) => {
				const image = await generateStoryBackgroundImage(
					section.genre.id,
					readingBackgroundMessages(section.genre, section.imagePrompt),
					section.storyId,
					{
						// Section 1 is the anchor itself; every later section attaches it.
						anchorToFirstSection: section.partIndex > 1,
						sectionIndex: section.partIndex,
						visualContext: section.visualContext,
					},
				);
				// A fallback image is the genre's stock picture, not this section's:
				// leave the previous background in place rather than swapping to it.
				return image.backgroundImageSource === "generated" ? image : null;
			},
		}),
	);

	useEffect(() => {
		activeSaveIdRef.current = activeSaveId;
	}, [activeSaveId]);

	useEffect(() => {
		currentTargetRef.current = currentTarget;
	}, [currentTarget]);

	useEffect(() => {
		phaseRef.current = phase;
	}, [phase]);

	useEffect(() => {
		openingAudioRef.current = openingAudio;
	}, [openingAudio]);

	useEffect(() => {
		readingStoryRef.current = readingStory;
	}, [readingStory]);

	const wordTranslationsRef = useRef<Record<string, string> | null>(null);
	useEffect(() => {
		wordTranslationsRef.current = wordTranslations;
	}, [wordTranslations]);

	useEffect(() => {
		readingPartIndexRef.current = readingPartIndex;
	}, [readingPartIndex]);

	useEffect(() => {
		narrationVoiceRef.current = narrationVoice;
	}, [narrationVoice]);

	useEffect(() => {
		storyRecapLessonRef.current = storyRecapLesson;
	}, [storyRecapLesson]);

	const makeStorySaveSnapshot = useRef(
		(input: Parameters<typeof buildStorySaveSnapshot>[0]) =>
			buildStorySaveSnapshot({
				...input,
				wordTranslations: wordTranslationsRef.current ?? undefined,
				storyRecapResults: storyRecapResultsRef.current,
				storyLearnerQuestions: botQuestionsRef.current,
				...readStoryFeedbackSnapshot(),
			}),
	);

	// The whole-story gloss map is seeded when a reading story starts (from the
	// prepared opening) or resumes (from the save). It follows the reading story:
	// clear it whenever there is no reading story.
	useEffect(() => {
		if (!readingStory) setWordTranslations(null);
	}, [readingStory]);

	const persistStory = useStoryPersistence({
		onSavedStoriesChanged,
		onSavesError,
	});

	/**
	 * Records a section's narration or image on the save without touching anything
	 * else on it. Media resolves on its own schedule — including immediately, when
	 * it was prepared with the story — so it must never be the write that decides
	 * what the rest of the save says.
	 */
	const persistStoryMedia = useCallback(
		async (
			saveId: string,
			media: Partial<StoryBackgroundImage> & Partial<StoryOpeningAudio>,
		) => {
			try {
				await saveStoryMedia(saveId, media);
				await onSavedStoriesChanged();
			} catch (err) {
				// It is already on screen and will ride along with the next real save,
				// so a failed patch costs nothing worth surfacing to the learner.
				console.warn("Could not record the story media.", err);
			}
		},
		[onSavedStoriesChanged],
	);

	// Narration the learner is looking at but does not have — a reload mid-story,
	// a section whose audio failed earlier. The media owner hands back the
	// request already running for this section rather than starting another.
	useEffect(() => {
		void openingAudioRetry;
		if (
			phase !== "reading" ||
			!genre ||
			!activeSaveId ||
			!currentTarget ||
			!readingStory ||
			readingPartIndex === null
		) {
			return;
		}
		if (
			openingAudio?.openingAudioText === currentTarget &&
			openingAudio.openingAudioVoice === narrationVoice
		) {
			setOpeningAudioLoading(false);
			setOpeningAudioError(false);
			return;
		}

		const section = readingMediaSection(
			genre,
			activeSaveId,
			readingStory,
			readingPartIndex,
			narrationVoice,
		);
		if (!section || section.text !== currentTarget) return;

		let cancelled = false;
		setOpeningAudioLoading(true);
		setOpeningAudioError(false);
		void readingMediaRef.current
			.requestAudio(section)
			.then((nextOpeningAudio) => {
				if (
					cancelled ||
					activeSaveIdRef.current !== activeSaveId ||
					currentTargetRef.current !== currentTarget ||
					readingPartIndexRef.current !== readingPartIndex
				) {
					return;
				}
				setOpeningAudioLoading(false);
				if (!nextOpeningAudio) {
					setOpeningAudioError(true);
					return;
				}

				setOpeningAudio(nextOpeningAudio);
				void persistStoryMedia(activeSaveId, nextOpeningAudio);
			});

		return () => {
			cancelled = true;
		};
	}, [
		activeSaveId,
		currentTarget,
		genre,
		narrationVoice,
		openingAudio,
		persistStoryMedia,
		phase,
		readingPartIndex,
		readingStory,
		openingAudioRetry,
	]);

	/** Shows a reading section's background as soon as the media owner has it. */
	const applyReadingBackground = useCallback(
		async (section: ReadingMediaSection) => {
			const image = await readingMediaRef.current.requestBackground(section);
			if (!image || activeSaveIdRef.current !== section.storyId) return;

			setBackgroundImage(image);
			await persistStoryMedia(section.storyId, image);
		},
		[persistStoryMedia],
	);

	/**
	 * Hands the media owner everything a story already has: narration recorded on
	 * the segments the learner has read, and the images the story has generated
	 * across its sessions. Sections covered by this are never generated again.
	 */
	const seedReadingMediaFromHistory = useCallback(
		({
			selected,
			saveId,
			story,
			voice,
			segments: history,
			imageMap,
		}: {
			selected: Language;
			saveId: string;
			story: ReadingStory;
			voice: NarrationVoiceId;
			segments: StorySegment[];
			imageMap: Record<number, StoryBackgroundImage>;
		}) => {
			story.parts.forEach((_part, index) => {
				const partIndex = index + 1;
				const section = readingMediaSection(
					selected,
					saveId,
					story,
					partIndex,
					voice,
				);
				if (!section) return;

				const media: Partial<ReadingSectionMedia> = {};
				const audio = history[index]?.narrationAudio ?? null;
				if (isStoryOpeningAudioForText(audio, section.text, voice)) {
					media.openingAudio = audio;
				}
				const image = imageMap[partIndex];
				if (image) media.backgroundImage = image;
				readingMediaRef.current.seed(section, media);
			});
		},
		[],
	);

	/** Warms the next section's media while the learner reads the current one. */
	const prepareNextReadingSection = useCallback(
		(
			selected: Language,
			saveId: string,
			story: ReadingStory,
			currentPartIndex: number,
		) => {
			const section = readingMediaSection(
				selected,
				saveId,
				story,
				currentPartIndex + 1,
				narrationVoiceRef.current,
			);
			if (!section) return;
			void readingMediaRef.current.prepare(section);
		},
		[],
	);

	const startReadingStory = useCallback(async () => {
		const selected = language;

		let preparedOpening: Awaited<
			ReturnType<typeof consumePreparedReadingOpening>
		> = null;
		try {
			preparedOpening = await consumePreparedReadingOpening(selected.id);
		} catch (err) {
			console.warn("Could not consume a prepared reading opening.", err);
		}
		if (!preparedOpening) {
			// Nothing was consumed, so there is no queued story to start and
			// nothing for the lifecycle to fold in. Generating one here would
			// bypass the lifecycle that keeps prepared stories in sync with
			// finalized evidence, so refuse instead and leave the menu in place
			// for preparation (or a retry of it) to fill the queue.
			retryReadingPreparationLifecycle();
			return;
		}
		// The queue is empty from here until this story is finished and
		// finalized; nothing prepares a replacement in the meantime.
		markReadingStoryConsumed();

		readingMediaRef.current.reset();
		justFinishedReadingRef.current = false;
		botQuestionsRef.current = [];
		storyRecapResultsRef.current = [];
		resetStoryFeedback();
		setGenre(selected);
		setMessages([]);
		setSegments([]);
		setCurrentTarget(null);
		setError(null);
		setOpeningAudio(null);
		setReadingStory(null);
		setReadingPartIndex(1);
		setStoryRecapLesson(null);
		storyRecapLessonRef.current = null;
		setStoryRecapError(null);
		setPhase("loading");
		try {
			const nextNarrationVoice = isNarrationVoiceId(
				preparedOpening.narrationVoice,
			)
				? preparedOpening.narrationVoice
				: pickRandomNarrationVoice();
			narrationVoiceRef.current = nextNarrationVoice;
			setNarrationVoice(nextNarrationVoice);

			const story = preparedOpening.readingStory;
			const firstPart = story.parts[0];
			if (!firstPart) throw new Error("The reading story has no parts.");

			const text = firstPart.text;
			const title = story.title.trim() || fallbackTitle(selected);
			const saveId = preparedOpening.id;
			activeSaveIdRef.current = saveId;
			setActiveSaveId(saveId);
			setActiveTitle(title);
			onViewChange("story", saveId);

			const seeded = readingStoryMessages(selected, story, 1);
			const firstSection = readingMediaSection(
				selected,
				saveId,
				story,
				1,
				nextNarrationVoice,
			);
			if (!firstSection) throw new Error("The reading story has no parts.");

			// Part 1's media was prepared with the queued story: hand it to the media
			// owner so nothing regenerates what we already have.
			if (
				preparedOpening.openingAudioUrl &&
				preparedOpening.openingAudioSource === "generated" &&
				preparedOpening.openingAudioVoice === nextNarrationVoice
			) {
				readingMediaRef.current.seed(firstSection, {
					openingAudio: {
						openingAudioUrl: preparedOpening.openingAudioUrl,
						openingAudioSource: preparedOpening.openingAudioSource,
						openingAudioText: preparedOpening.openingAudioText ?? text,
						openingAudioVoice: preparedOpening.openingAudioVoice,
					},
				});
			}
			if (preparedOpening.backgroundImageSource === "generated") {
				readingMediaRef.current.seed(firstSection, {
					backgroundImage: backgroundFromOpening(preparedOpening, selected),
				});
			}

			const nextBackgroundImage = backgroundFromOpening(
				preparedOpening,
				selected,
			);
			const nextOpeningAudio =
				await readingMediaRef.current.requestAudio(firstSection);
			setMessages(seeded);
			setCurrentTarget(text);
			setBackgroundIntro(null);
			setBackgroundImage(nextBackgroundImage);
			setOpeningAudio(nextOpeningAudio);
			setReadingStory(story);
			readingStoryRef.current = story;
			wordTranslationsRef.current = preparedOpening.wordTranslations ?? {};
			setWordTranslations(preparedOpening.wordTranslations ?? {});
			setReadingPartIndex(1);
			setPhase("reading");
			void persistStory(
				makeStorySaveSnapshot.current({
					id: saveId,
					genre: selected,
					title,
					messages: seeded,
					segments: [],
					currentTarget: text,
					phase: "reading",
					backgroundImage: nextBackgroundImage,
					openingAudio: nextOpeningAudio,
					readingStory: story,
					readingPartIndex: 1,
					narrationVoice: nextNarrationVoice,
				}),
			);
			void applyReadingBackground(firstSection);
			prepareNextReadingSection(selected, saveId, story, 1);
		} catch (err) {
			setPhase("error");
			setError(describeError(err));
		}
	}, [
		applyReadingBackground,
		language,
		markReadingStoryConsumed,
		onViewChange,
		persistStory,
		prepareNextReadingSection,
		retryReadingPreparationLifecycle,
		resetStoryFeedback,
	]);

	const generateAndApplyStoryRecap = useCallback(
		async (finishedSegments: StorySegment[]) => {
			if (!genre || !activeSaveId || !readingStory) return;

			setStoryRecapError(null);
			setPhase("recap-loading");

			try {
				const storyParts = finishedSegments
					.filter((segment) => segment.author === "ai")
					.map((segment) => segment.text);
				// Reuse the contextual glosses prepared with the story; they already
				// cover every story word, so the recap needs no fresh translation call.
				const translations = wordTranslationsRef.current ?? {};
				// The recap is a small structured exercise, not prose, so it does not
				// follow the story-generation preset (a prose-tier model + reasoning
				// effort chosen for the story itself). It uses EXERCISE_MODEL.
				const lesson = await generateStoryRecapLesson({
					genreId: language.id,
					storyParts,
					languageFocuses: [readingStory.languageFocus],
					wordTranslations: translations,
				});

				storyRecapLessonRef.current = lesson;
				setStoryRecapLesson(lesson);
				setStoryRecapError(null);
				setPhase("recap");
				void persistStory(
					makeStorySaveSnapshot.current({
						id: activeSaveId,
						genre,
						title: activeTitle ?? fallbackTitle(genre),
						messages,
						segments: finishedSegments,
						currentTarget: null,
						phase: "recap",
						backgroundIntro: backgroundIntro ?? undefined,
						backgroundImage,
						openingAudio: null,
						readingStory,
						readingPartIndex: readingPartIndex ?? readingStory.parts.length,
						narrationVoice,
						storyRecapLesson: lesson,
					}),
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setStoryRecapError(`Could not build the recap practice: ${message}`);
				setPhase("recap-loading");
				void persistStory(
					makeStorySaveSnapshot.current({
						id: activeSaveId,
						genre,
						title: activeTitle ?? fallbackTitle(genre),
						messages,
						segments: finishedSegments,
						currentTarget: null,
						phase: "recap-loading",
						backgroundIntro: backgroundIntro ?? undefined,
						backgroundImage,
						openingAudio: null,
						readingStory,
						readingPartIndex: readingPartIndex ?? readingStory.parts.length,
						narrationVoice,
						storyRecapLesson: storyRecapLessonRef.current,
					}),
				);
			}
		},
		[
			activeSaveId,
			activeTitle,
			backgroundImage,
			backgroundIntro,
			genre,
			messages,
			narrationVoice,
			persistStory,
			readingStory,
			readingPartIndex,
			language.id,
		],
	);

	/**
	 * Moves to the next section of the story that already exists. No text is
	 * generated here: the next part is `readingStory.parts[nextIndex - 1]`, and
	 * its narration was prepared while the learner read the current section.
	 */
	const continueReadingStory = useCallback(async () => {
		if (
			!genre ||
			!activeSaveId ||
			!readingStory ||
			readingPartIndex === null ||
			currentTarget === null
		) {
			return;
		}

		const currentSection = readingMediaSection(
			genre,
			activeSaveId,
			readingStory,
			readingPartIndex,
			narrationVoice,
		);
		if (!currentSection) return;

		const currentOpeningAudio = isStoryOpeningAudioForText(
			openingAudioRef.current,
			currentTarget,
			narrationVoice,
		)
			? openingAudioRef.current
			: null;

		if (
			activeSaveIdRef.current !== activeSaveId ||
			currentTargetRef.current !== currentTarget ||
			readingPartIndexRef.current !== readingPartIndex
		) {
			return;
		}
		const nextSegments: StorySegment[] = [
			...segments,
			completedAiSegment(segments.length, currentTarget, currentOpeningAudio),
		];
		const totalParts = readingStory.parts.length;
		setError(null);

		if (readingPartIndex >= totalParts) {
			setSegments(nextSegments);
			setCurrentTarget(null);
			setOpeningAudio(null);
			setStoryRecapLesson(null);
			storyRecapLessonRef.current = null;
			setStoryRecapError(null);
			setPhase("recap-loading");
			void persistStory(
				makeStorySaveSnapshot.current({
					id: activeSaveId,
					genre,
					title: activeTitle ?? fallbackTitle(genre),
					messages,
					segments: nextSegments,
					currentTarget: null,
					phase: "recap-loading",
					backgroundIntro: backgroundIntro ?? undefined,
					backgroundImage,
					openingAudio: null,
					readingStory,
					readingPartIndex,
					narrationVoice,
					storyRecapLesson: null,
				}),
			);
			void generateAndApplyStoryRecap(nextSegments);
			return;
		}

		const nextPartIndex = readingPartIndex + 1;
		const nextSection = readingMediaSection(
			genre,
			activeSaveId,
			readingStory,
			nextPartIndex,
			narrationVoice,
		);
		if (!nextSection) return;

		const text = nextSection.text;
		const updatedMessages = readingStoryMessages(
			genre,
			readingStory,
			nextPartIndex,
		);
		if (activeSaveIdRef.current !== activeSaveId) return;

		setSegments(nextSegments);
		setMessages(updatedMessages);
		setCurrentTarget(text);
		setOpeningAudio(null);
		setOpeningAudioLoading(true);
		setOpeningAudioError(false);
		setReadingPartIndex(nextPartIndex);
		setPhase("reading");
		void persistStory(
			makeStorySaveSnapshot.current({
				id: activeSaveId,
				genre,
				title: activeTitle ?? fallbackTitle(genre),
				messages: updatedMessages,
				segments: nextSegments,
				currentTarget: text,
				phase: "reading",
				backgroundIntro: backgroundIntro ?? undefined,
				backgroundImage,
				openingAudio: null,
				readingStory,
				readingPartIndex: nextPartIndex,
				narrationVoice,
			}),
		);

		// The background this section was prepared with, applied the moment it is
		// there; sections the cadence skips keep the previous image.
		void applyReadingBackground(nextSection);
		prepareNextReadingSection(genre, activeSaveId, readingStory, nextPartIndex);
	}, [
		activeSaveId,
		activeTitle,
		applyReadingBackground,
		backgroundImage,
		backgroundIntro,
		currentTarget,
		genre,
		messages,
		narrationVoice,
		persistStory,
		prepareNextReadingSection,
		readingStory,
		readingPartIndex,
		generateAndApplyStoryRecap,
		segments,
	]);

	const retryOpeningAudio = useCallback(() => {
		setOpeningAudioError(false);
		setOpeningAudioLoading(true);
		setOpeningAudioRetry((value) => value + 1);
	}, []);

	const completeStoryRecap = useCallback(
		(results: StoryRecapExerciseResult[] = []) => {
			if (!genre || !activeSaveId) return;
			storyRecapResultsRef.current = results;
			justFinishedReadingRef.current = true;
			// A live finish: the feedback form is submittable, and its draft starts
			// empty so nothing from a previous story leaks into this resolution.
			beginStoryFeedback();
			setPhase("finished");
			setStoryRecapError(null);
			void persistStory(
				makeStorySaveSnapshot.current({
					id: activeSaveId,
					genre,
					title: activeTitle ?? fallbackTitle(genre),
					messages,
					segments,
					currentTarget: null,
					phase: "finished",
					backgroundIntro: backgroundIntro ?? undefined,
					backgroundImage,
					openingAudio: null,
					readingStory: readingStory ?? undefined,
					readingPartIndex: readingPartIndex ?? undefined,
					narrationVoice,
					storyRecapLesson,
				}),
			);
		},
		[
			activeSaveId,
			activeTitle,
			backgroundImage,
			backgroundIntro,
			genre,
			messages,
			narrationVoice,
			persistStory,
			readingStory,
			readingPartIndex,
			segments,
			storyRecapLesson,
			beginStoryFeedback,
		],
	);

	const retryStoryRecap = useCallback(() => {
		void generateAndApplyStoryRecap(segments);
	}, [generateAndApplyStoryRecap, segments]);

	const skipStoryRecap = useCallback(() => {
		completeStoryRecap();
	}, [completeStoryRecap]);

	/**
	 * Hands the finished reading story to the preparation lifecycle: its evidence
	 * is finalized, and only then is the next story prepared. The evidence is
	 * captured here rather than read when finalization runs, because the caller
	 * clears the session as it navigates away.
	 */
	const finalizeReadingEvidence = useCallback(
		(resolved: ResolvedStoryFeedback) => {
			const story = readingStoryRef.current;
			const saveId = activeSaveIdRef.current;
			// `justFinishedReadingRef` is what makes this safe to call from both
			// `backToMenu` and `submitStoryFeedback` without double-finalizing —
			// and, more importantly, what stops rereading an already-finished save
			// from finalizing it again against evidence a later story has since
			// superseded.
			if (
				!story ||
				!saveId ||
				phaseRef.current !== "finished" ||
				!justFinishedReadingRef.current
			) {
				return;
			}
			justFinishedReadingRef.current = false;
			makeNextReadingStory(
				{
					genreId: language.id,
					storyId: saveId,
					storySummary: readingStorySummary(story),
					storyParts: story.parts.map((part) => part.text),
					languageFocus: story.languageFocus,
					...(story.generationBrief
						? { generationBrief: story.generationBrief }
						: {}),
					learnerQuestions: botQuestionsRef.current,
					recapResults: storyRecapResultsRef.current,
					...(resolved.difficulty ? { difficulty: resolved.difficulty } : {}),
					...(resolved.practiceRequest
						? { practiceRequest: resolved.practiceRequest }
						: {}),
				},
				resolved.nextStoryTheme,
			);
		},
		[language.id, makeNextReadingStory],
	);

	const backToMenu = useCallback(() => {
		if (readingStory && activeSaveId && phase === "finished") {
			// Leaving the completion screen resolves feedback from whatever is on the
			// form right now — Submit is not required. finalizeReadingEvidence is
			// guarded by justFinishedReadingRef, so a reread's leave is a no-op and
			// its stale draft is never consumed.
			finalizeReadingEvidence(resolveStoryFeedback());
		}
		if (genre && activeSaveId) {
			void persistStory(
				makeStorySaveSnapshot.current({
					id: activeSaveId,
					genre,
					title: activeTitle ?? fallbackTitle(genre),
					messages,
					segments,
					currentTarget,
					phase,
					backgroundIntro: backgroundIntro ?? undefined,
					backgroundImage,
					openingAudio,
					readingStory: readingStory ?? undefined,
					readingPartIndex: readingPartIndex ?? undefined,
					narrationVoice,
					storyRecapLesson: storyRecapLessonRef.current,
				}),
			);
		}
		readingMediaRef.current.reset();
		justFinishedReadingRef.current = false;
		onViewChange("menu");
		setGenre(null);
		setMessages([]);
		setSegments([]);
		setCurrentTarget(null);
		setError(null);
		setPhase("loading");
		setBackgroundIntro(null);
		setBackgroundImage(null);
		setOpeningAudio(null);
		setReadingStory(null);
		setReadingPartIndex(null);
		setStoryRecapLesson(null);
		storyRecapLessonRef.current = null;
		setStoryRecapError(null);
		setNarrationVoice(DEFAULT_NARRATION_VOICE);
		narrationVoiceRef.current = DEFAULT_NARRATION_VOICE;
		activeSaveIdRef.current = null;
		setActiveSaveId(null);
		setActiveTitle(null);
		setWordTranslations(null);
	}, [
		activeSaveId,
		activeTitle,
		backgroundIntro,
		currentTarget,
		genre,
		messages,
		onViewChange,
		persistStory,
		phase,
		backgroundImage,
		openingAudio,
		readingStory,
		readingPartIndex,
		narrationVoice,
		segments,
		finalizeReadingEvidence,
		resolveStoryFeedback,
	]);

	const resumeStory = useCallback(
		async (id: string) => {
			try {
				onSavesError(null);
				const save = await loadSavedStory(id);
				const selected = getLanguage(save.genreId);
				// A resumed save is never "just finished" in this session, even one
				// that was already finished when saved — rereading it must not
				// re-finalize it.
				justFinishedReadingRef.current = false;
				activeSaveIdRef.current = save.id;
				const readingTotalParts = save.readingStory?.parts.length;
				const restoredPhase: StoryPhase =
					save.phase === "reading" &&
					save.currentTarget === null &&
					readingTotalParts !== undefined &&
					save.segments.filter((segment) => segment.author === "ai").length >=
						readingTotalParts
						? save.storyRecapLesson
							? "recap"
							: "recap-loading"
						: save.phase === "recap-loading" && save.storyRecapLesson
							? "recap"
							: save.phase;
				const savedNarrationVoice = isNarrationVoiceId(save.narrationVoice)
					? save.narrationVoice
					: DEFAULT_NARRATION_VOICE;
				const savedBackgroundImage =
					save.backgroundImageUrl &&
					(save.backgroundImageSource === "generated" ||
						save.backgroundImageSource === "fallback")
						? {
								backgroundImageUrl: save.backgroundImageUrl,
								backgroundImagePrompt: save.backgroundImagePrompt,
								backgroundImageSource: save.backgroundImageSource,
							}
						: fallbackBackgroundImage(selected);
				const savedOpeningAudio =
					save.openingAudioUrl && save.openingAudioSource === "generated"
						? {
								openingAudioUrl: save.openingAudioUrl,
								openingAudioSource: save.openingAudioSource,
								openingAudioText:
									save.openingAudioText ?? save.currentTarget ?? "",
								openingAudioVoice: save.openingAudioVoice,
							}
						: null;

				setActiveSaveId(save.id);
				setActiveTitle(save.title);
				setGenre(selected);
				setMessages(save.messages);
				setSegments(save.segments);
				setCurrentTarget(save.currentTarget);
				setPhase(restoredPhase);
				setReadingStory(save.readingStory ?? null);
				readingStoryRef.current = save.readingStory ?? null;
				wordTranslationsRef.current = save.wordTranslations ?? null;
				setWordTranslations(save.wordTranslations ?? null);
				setReadingPartIndex(save.readingPartIndex ?? null);
				narrationVoiceRef.current = savedNarrationVoice;
				setNarrationVoice(savedNarrationVoice);
				setBackgroundIntro(save.backgroundIntro ?? null);
				setBackgroundImage(savedBackgroundImage);
				setOpeningAudio(savedOpeningAudio);
				storyRecapLessonRef.current = save.storyRecapLesson ?? null;
				setStoryRecapLesson(save.storyRecapLesson ?? null);
				storyRecapResultsRef.current = save.storyRecapResults ?? [];
				botQuestionsRef.current = save.storyLearnerQuestions ?? [];
				// A reopened save is never a live finish: its feedback form is
				// read-only, showing only whatever rating was recorded before.
				loadStoryFeedbackFromSave(
					save.storyFeedback ?? null,
					save.storyFeedbackSubmittedAt ?? null,
				);
				setStoryRecapError(
					restoredPhase === "recap-loading"
						? "The recap practice needs to be generated again."
						: null,
				);
				setError(null);
				onViewChange("story", save.id);

				const story = save.readingStory;
				const partIndex = save.readingPartIndex;
				if (!story || !partIndex || restoredPhase !== "reading") return;

				// A resumed story keeps whatever media it has already generated: the
				// narration on its segments, the images in its gallery. Only what is
				// genuinely missing is prepared again.
				readingMediaRef.current.reset();
				const imageMap = await listStoryImages(save.id)
					.then(buildSectionImageMap)
					.catch((err) => {
						console.warn("Could not load story images for resume.", err);
						return {} as Record<number, StoryBackgroundImage>;
					});
				if (activeSaveIdRef.current !== save.id) return;

				seedReadingMediaFromHistory({
					selected,
					saveId: save.id,
					story,
					voice: savedNarrationVoice,
					segments: save.segments,
					imageMap,
				});
				const currentSection = readingMediaSection(
					selected,
					save.id,
					story,
					partIndex,
					savedNarrationVoice,
				);
				if (currentSection) {
					readingMediaRef.current.seed(currentSection, {
						...(isStoryOpeningAudioForText(
							savedOpeningAudio,
							currentSection.text,
							savedNarrationVoice,
						)
							? { openingAudio: savedOpeningAudio }
							: {}),
						...(savedBackgroundImage.backgroundImageSource === "generated"
							? { backgroundImage: savedBackgroundImage }
							: {}),
					});
				}
				prepareNextReadingSection(selected, save.id, story, partIndex);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setGenre(null);
				setError(`Could not load story: ${message}`);
				onSavesError(`Could not load story: ${message}`);
			}
		},
		[
			onSavesError,
			onViewChange,
			prepareNextReadingSection,
			seedReadingMediaFromHistory,
			loadStoryFeedbackFromSave,
		],
	);

	const submitStoryFeedback = useCallback(
		(record: StoryFeedbackRecord) => {
			const resolved = submitFeedbackValues(record);
			if (genre && activeSaveId) {
				void persistStory(
					makeStorySaveSnapshot.current({
						id: activeSaveId,
						genre,
						title: activeTitle ?? fallbackTitle(genre),
						messages,
						segments,
						currentTarget,
						phase,
						backgroundIntro: backgroundIntro ?? undefined,
						backgroundImage,
						openingAudio,
						readingStory: readingStory ?? undefined,
						readingPartIndex: readingPartIndex ?? undefined,
						narrationVoice,
						storyRecapLesson: storyRecapLessonRef.current,
					}),
				);
			}
			if (readingStory && phase === "finished") {
				finalizeReadingEvidence(resolved);
			}
		},
		[
			activeSaveId,
			activeTitle,
			backgroundImage,
			backgroundIntro,
			currentTarget,
			genre,
			messages,
			openingAudio,
			narrationVoice,
			persistStory,
			phase,
			readingStory,
			readingPartIndex,
			segments,
			finalizeReadingEvidence,
			submitFeedbackValues,
		],
	);

	// The tutor chat hands the learner's questions here as it closes, instead of
	// refining the profile immediately, so they fold once into the baseline at
	// story end. Deduped and bounded so repeated opens can't bloat the evidence.
	const captureBotQuestions = useCallback(
		(questions: string[]) => {
			const seen = new Set(botQuestionsRef.current);
			let changed = false;
			for (const raw of questions) {
				if (botQuestionsRef.current.length >= MAX_BUFFERED_BOT_QUESTIONS) break;
				const question = raw.trim().slice(0, MAX_BOT_QUESTION_CHARS);
				if (!question || seen.has(question)) continue;
				seen.add(question);
				botQuestionsRef.current.push(question);
				changed = true;
			}
			if (changed && genre && activeSaveId && readingStory) {
				void persistStory(
					makeStorySaveSnapshot.current({
						id: activeSaveId,
						genre,
						title: activeTitle ?? fallbackTitle(genre),
						messages,
						segments,
						currentTarget,
						phase,
						backgroundIntro: backgroundIntro ?? undefined,
						backgroundImage,
						openingAudio,
						readingStory,
						readingPartIndex: readingPartIndex ?? undefined,
						narrationVoice,
						storyRecapLesson: storyRecapLessonRef.current,
					}),
				);
			}
		},
		[
			activeSaveId,
			activeTitle,
			backgroundImage,
			backgroundIntro,
			currentTarget,
			genre,
			messages,
			narrationVoice,
			openingAudio,
			persistStory,
			phase,
			readingPartIndex,
			readingStory,
			segments,
		],
	);

	const handleRegenerateWord = useCallback(
		async (word: string): Promise<string | null> => {
			try {
				const storyContext = readingStoryRef.current?.parts
					.map((part) => part.text)
					.join("\n");
				const translation = await regenerateWordTranslation(
					language.id,
					word,
					storyContext,
				);
				if (translation !== null) {
					setWordTranslations((prev) =>
						prev ? { ...prev, [word]: translation } : { [word]: translation },
					);
				}
				return translation;
			} catch (err) {
				console.warn("Could not regenerate word translation.", err);
				return null;
			}
		},
		[language.id],
	);

	return {
		activeSaveId,
		backToMenu,
		backgroundImage,
		backgroundIntro,
		completeStoryRecap,
		continueReadingStory,
		currentTarget,
		error,
		genre,
		phase,
		startReadingStory,
		openingAudio:
			currentTarget &&
			isStoryOpeningAudioForText(openingAudio, currentTarget, narrationVoice)
				? openingAudio
				: null,
		openingAudioLoading,
		openingAudioError,
		retryOpeningAudio,
		narrationVoice,
		nonTranslatableWords: readingStory?.properNames ?? [],
		regenerateWordTranslation: handleRegenerateWord,
		resumeStory,
		readingPartIndex,
		readingPreparationStatus: readingPreparation.status,
		readingPreparationError: readingPreparation.error,
		retryReadingPreparation: readingPreparation.retry,
		readingTotalParts: readingStory?.parts.length ?? null,
		captureBotQuestions,
		retryStoryRecap,
		segments,
		skipStoryRecap,
		storyRecapError,
		storyRecapLesson,
		storyFeedbackSubmittedAt,
		storyFeedback,
		feedbackEditable,
		onStoryFeedbackDraftChange: handleStoryFeedbackDraftChange,
		submitStoryFeedback,
		wordTranslations,
	};
}
