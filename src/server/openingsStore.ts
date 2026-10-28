import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type OpenAI from "openai";
import sharp from "sharp";
import {
	getLanguage,
	type Language,
	type LanguageId,
	languageHeroImageUrl,
	languages,
	languageTtsInstructions,
	starterBriefForLanguage,
} from "../languages";
import { DEFAULT_TEXT_MODEL, type TextReasoningEffort } from "../models";
import {
	isNarrationVoiceId,
	type NarrationVoiceId,
	pickRandomNarrationVoice,
} from "../narrationVoice";
import { readingSectionDialogue } from "../reading_story/dialogue";
import { READING_STORY_MAX_PARTS } from "../reading_story/split";
import { readingImageParts } from "../reading_story/visualPlan";
import {
	type ChatMessage,
	generateReadingStory,
	type ReadingStory,
	readingImagePrompt,
	readingStoryMessages,
	readingVisualContext,
} from "../story";
import type { StoryOpeningAudio } from "../storyAudio";
import type { StoryBackgroundImage } from "../storyBackground";
import { storyWords } from "../storyVocabulary";
import { DEFAULT_TTS_MODEL, type TtsModelId } from "../ttsModel";
import { completeStructuredAi, translateWords } from "./aiService";
import {
	buildStoryBackgroundPrompt,
	type GeneratedStoryImage,
	generateStoryImage,
} from "./images";
import { readLearnerContext } from "./learnerProfileStore";
import { learnerReadingOpeningsDir } from "./learnerScope";
import { createOpeningAudio } from "./storyAudioStore";
import {
	bundledImagesPath,
	bundleIdPattern,
	createBundleId,
	pathExists,
	storyBundlePath,
} from "./storyBundleStore";
import { readFinishEvidence } from "./storyFinishEvidenceStore";
import { queueWordAudioPrewarm } from "./wordAudioStore";

const storyImagesDir = join(process.cwd(), "story-images");

export const imageFilePattern = /^[a-zA-Z0-9_-]+\.(jpe?g|png|webp)$/;

/**
 * The single queued reading story. It holds the whole generated story, so
 * starting it costs no text generation; `text` and the media fields are part 1,
 * prepared ahead so the first screen appears immediately.
 */
interface PreparedReadingOpening
	extends Partial<StoryBackgroundImage>,
		Partial<StoryOpeningAudio> {
	id: string;
	genreId: LanguageId;
	title?: string;
	text: string;
	messages: ChatMessage[];
	readingStory: ReadingStory;
	/** Contextual glosses for every story word, generated once at prepare time. */
	wordTranslations: Record<string, string>;
	readingPartIndex: number;
	narrationVoice: NarrationVoiceId;
	createdAt: string;
	/**
	 * The finished story this was prepared after finalizing, or `null` for the
	 * very first story. Compared against the id the caller is preparing for so a
	 * queued entry generated before the latest finalization is never handed out.
	 */
	basedOnStoryId: string | null;
}

export async function listPreparedReadingOpenings(
	learnerId: string,
	genreId?: LanguageId,
) {
	const openings = await Promise.all(
		(genreId ? [getLanguage(genreId)] : languages).map(async (genre) =>
			readPreparedReadingOpening(learnerId, genre.id),
		),
	);

	return openings
		.filter((opening) => opening !== null)
		.map((opening) => ({
			genreId: opening.genreId,
			createdAt: opening.createdAt,
		}));
}

/** The first section's attributed speech, for narrating it per character. */
function firstSectionDialogue(genre: Language, story: ReadingStory) {
	const section = readingSectionDialogue(
		story.parts,
		story.characters,
		story.dialogue,
		1,
		genre.dialogueQuotes,
	);
	return section ? { dialogue: { quotes: genre.dialogueQuotes, section } } : {};
}

export async function prepareMissingReadingOpenings(
	openai: OpenAI,
	learnerId: string,
	genreId: LanguageId = "esperanto",
	model = DEFAULT_TEXT_MODEL,
	anthropicKey = "",
	basedOnStoryId: string | null = null,
	nextTheme?: string,
	reasoningEffort: TextReasoningEffort = "low",
	ttsModel: TtsModelId = DEFAULT_TTS_MODEL,
) {
	for (const genre of [getLanguage(genreId)]) {
		try {
			const existing = await readPreparedReadingOpening(learnerId, genre.id);
			if (existing && existing.basedOnStoryId !== basedOnStoryId) {
				// Stale relative to the finalization this call follows: it was
				// generated against a different predecessor's handoff.
				// The queue is a cache, not history — discard it and generate fresh.
				await rm(readingOpeningPath(learnerId, genre.id), { force: true });
			} else if (existing) {
				let changed = false;
				const next: PreparedReadingOpening = { ...existing };
				const narrationVoice = isNarrationVoiceId(existing.narrationVoice)
					? existing.narrationVoice
					: pickRandomNarrationVoice();
				if (next.narrationVoice !== narrationVoice) {
					next.narrationVoice = narrationVoice;
					changed = true;
				}
				if (
					!existing.openingAudioUrl ||
					existing.openingAudioVoice !== narrationVoice
				) {
					Object.assign(
						next,
						(await createOpeningAudio(
							openai,
							existing.text,
							existing.id,
							narrationVoice,
							{
								sectionIndex: 1,
								ttsModel,
								instructions: languageTtsInstructions(genre),
								...firstSectionDialogue(genre, existing.readingStory),
							},
						)) ?? {},
					);
					changed = true;
				}
				if (!existing.backgroundImageUrl) {
					Object.assign(
						next,
						await createBackgroundImage(
							openai,
							genre,
							readingImagePrompt(existing.readingStory, 1),
							existing.id,
							{
								sectionIndex: 1,
								visualContext: readingVisualContext(existing.readingStory),
							},
						),
					);
					changed = true;
				}
				if (changed) await writePreparedReadingOpening(learnerId, next);
				continue;
			}

			const opening = await createPreparedReadingOpening(
				openai,
				learnerId,
				genre,
				model,
				anthropicKey,
				basedOnStoryId,
				nextTheme,
				reasoningEffort,
				ttsModel,
			);
			await writePreparedReadingOpening(learnerId, opening);
		} catch (err) {
			console.warn(`Could not prepare ${genre.label} reading opening.`, err);
		}
	}
}

export async function consumePreparedReadingOpening(
	learnerId: string,
	genreId: LanguageId,
): Promise<PreparedReadingOpening | null> {
	const opening = await readPreparedReadingOpening(learnerId, genreId);
	if (!opening) return null;
	await rm(readingOpeningPath(learnerId, genreId), { force: true });
	return opening;
}

/** Where a story image lives on disk: its story bundle, or the generated images. */
export async function storyImageFile(relativePath: string) {
	const [storyId, filename] = relativePath.split("/");
	if (storyId && filename) {
		const bundled = bundledImagesPath(storyId, filename);
		if (await pathExists(bundled)) return bundled;
	}
	return join(storyImagesDir, relativePath);
}

export async function readStoryImage(relativePath: string) {
	return readFile(await storyImageFile(relativePath));
}

export async function listStoryImages(storyId: string): Promise<string[]> {
	const bundledFolder = join(storyBundlePath(storyId), "images");
	try {
		const files = await readdir(bundledFolder).catch(() => []);
		return [...new Set(files)]
			.filter((f) => imageFilePattern.test(f))
			.sort()
			.map((f) => `/api/story-images/${storyId}/${f}`);
	} catch {
		return [];
	}
}

export function findLanguage(genreId: string): Language | undefined {
	return languages.find((genre) => genre.id === genreId);
}

async function createPreparedReadingOpening(
	openai: OpenAI,
	learnerId: string,
	genre: Language,
	model = DEFAULT_TEXT_MODEL,
	anthropicKey = "",
	basedOnStoryId: string | null = null,
	nextTheme?: string,
	reasoningEffort: TextReasoningEffort = "low",
	ttsModel: TtsModelId = DEFAULT_TTS_MODEL,
): Promise<PreparedReadingOpening> {
	const { preferences, storyMemory } = await readLearnerContext(learnerId);
	// The previous story's finalizer owns the complete pedagogical handoff. The
	// first story starts from one fixed baseline rather than inferred history.
	const nextStoryBrief = basedOnStoryId
		? ((await readFinishEvidence(basedOnStoryId)).nextStoryBrief ??
			starterBriefForLanguage(genre))
		: starterBriefForLanguage(genre);
	const readingStory = await generateReadingStory(
		(messages, maxTokens, options) =>
			completeStructuredAi(
				openai,
				messages,
				maxTokens,
				options?.model ?? model,
				anthropicKey,
				options,
			),
		genre,
		{ prefer: preferences.prefer, avoid: preferences.avoid },
		nextTheme,
		{
			reasoningEffort,
			nextStoryBrief,
			recentStories: storyMemory.recentStories.filter(
				(story) => story.genreId === genre.id,
			),
		},
	);
	const text = readingStory.parts[0].text;
	const title = readingStory.title;
	const id = createBundleId(genre.id, title, randomUUID());
	const narrationVoice = pickRandomNarrationVoice();
	// Starts alongside the first section's media but is not awaited: the story
	// is ready to read without it, and its batches are paced in the background.
	void queueWordAudioPrewarm(
		openai,
		genre.id,
		wordsBySection(readingStory, genre.id),
		ttsModel,
	);
	const [backgroundImage, openingAudio, wordTranslations] = await Promise.all([
		createBackgroundImage(
			openai,
			genre,
			readingImagePrompt(readingStory, 1),
			id,
			{
				sectionIndex: 1,
				visualContext: readingVisualContext(readingStory),
			},
		),
		createOpeningAudio(openai, text, id, narrationVoice, {
			sectionIndex: 1,
			ttsModel,
			instructions: languageTtsInstructions(genre),
			...firstSectionDialogue(genre, readingStory),
		}),
		prewarmReadingTranslations(openai, genre, readingStory),
	]);
	return {
		id,
		genreId: genre.id,
		title,
		text,
		messages: readingStoryMessages(genre, readingStory, 1),
		readingStory,
		readingPartIndex: 1,
		narrationVoice,
		wordTranslations,
		...backgroundImage,
		...(openingAudio ?? {}),
		createdAt: new Date().toISOString(),
		basedOnStoryId,
	};
}

/** Each story word under the section where it first appears. */
function wordsBySection(story: ReadingStory, genreId: LanguageId): string[][] {
	const seen = new Set<string>();
	return story.parts.map((part) =>
		storyWords([part.text], story.properNames, genreId).filter((word) => {
			if (seen.has(word)) return false;
			seen.add(word);
			return true;
		}),
	);
}

async function prewarmReadingTranslations(
	openai: OpenAI,
	genre: Language,
	readingStory: ReadingStory,
): Promise<Record<string, string>> {
	try {
		const partTexts = readingStory.parts.map((part) => part.text);
		const words = storyWords(partTexts, readingStory.properNames, genre.id);
		if (words.length === 0) return {};
		return await translateWords(openai, genre, words, partTexts.join("\n"));
	} catch (err) {
		console.warn("Could not prewarm reading-story translations.", err);
		return {};
	}
}

const backgroundImagesInFlight = new Map<
	string,
	Promise<StoryBackgroundImage>
>();

interface BackgroundImageOptions {
	sectionIndex?: number;
	visualContext?: string;
	/** Anchor later illustrations to section 1 so recurring characters stay stable. */
	anchorToFirstSection?: boolean;
}

const ANCHOR_WIDTH = 768;
const ANCHOR_HEIGHT = 432;
const ANCHOR_QUALITY = 90;

const STORED_IMAGE_WIDTH = 1280;
const STORED_IMAGE_HEIGHT = 720;
const STORED_IMAGE_QUALITY = 80;

/**
 * OpenAI is asked for compressed WebP at the right size, so its output is
 * stored as-is; re-encoding it would compress it twice. Other providers pick
 * their own size and format, so they are shrunk and re-encoded here, which
 * also lets section 1 always be read back as the anchor.
 */
async function storableImage(image: GeneratedStoryImage): Promise<Buffer> {
	if (image.provider === "openai") return image.image;
	return sharp(image.image)
		.resize(STORED_IMAGE_WIDTH, STORED_IMAGE_HEIGHT, {
			fit: "inside",
			withoutEnlargement: true,
		})
		.webp({ quality: STORED_IMAGE_QUALITY })
		.toBuffer();
}

async function readAnchorImage(storyId: string): Promise<Buffer | null> {
	try {
		const original = await readStoryImage(`${storyId}/section_1.webp`);
		return await sharp(original)
			.resize(ANCHOR_WIDTH, ANCHOR_HEIGHT)
			.webp({ quality: ANCHOR_QUALITY })
			.toBuffer();
	} catch {
		return null;
	}
}

export async function createBackgroundImage(
	openai: OpenAI,
	genre: Language,
	storyText: string,
	storyId: string,
	options: BackgroundImageOptions = {},
): Promise<StoryBackgroundImage> {
	// Keyed on the request rather than on the finished prompt: resolving the
	// anchor image is async, and the dedupe has to happen before the first await
	// or two concurrent callers both miss the map and pay for the same picture.
	const key = [
		genre.id,
		storyId,
		options.sectionIndex ?? "none",
		options.anchorToFirstSection ? "anchored" : "plain",
		options.visualContext ?? "",
		storyText,
	].join("\0");
	const inFlight = backgroundImagesInFlight.get(key);
	if (inFlight) return inFlight;

	const request = generateBackgroundImage(
		openai,
		genre,
		storyText,
		storyId,
		options,
	).finally(() => {
		backgroundImagesInFlight.delete(key);
	});
	backgroundImagesInFlight.set(key, request);
	return request;
}

async function generateBackgroundImage(
	openai: OpenAI,
	genre: Language,
	storyText: string,
	storyId: string,
	options: BackgroundImageOptions,
): Promise<StoryBackgroundImage> {
	const referenceImage = options.anchorToFirstSection
		? await readAnchorImage(storyId)
		: null;
	const prompt = buildStoryBackgroundPrompt(
		genre,
		storyText,
		options.visualContext,
		Boolean(referenceImage),
	);
	try {
		const image = await generateStoryImage({
			genre,
			openai,
			referenceImage: referenceImage ?? undefined,
			storyText,
			visualContext: options.visualContext,
		});
		const filename = imageFilename(genre, options.sectionIndex);
		const filePath = imagePath(storyId, filename);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, await storableImage(image));
		return {
			backgroundImageUrl: `/api/story-images/${storyId}/${filename}`,
			backgroundImagePrompt: prompt,
			backgroundImageSource: "generated",
		};
	} catch (err) {
		console.warn(`Could not generate ${genre.label} background image.`, err);
		return {
			backgroundImageUrl: fallbackBackgroundUrl(genre.id),
			backgroundImagePrompt: prompt,
			backgroundImageSource: "fallback",
		};
	}
}

async function readPreparedReadingOpening(
	learnerId: string,
	genreId: LanguageId,
): Promise<PreparedReadingOpening | null> {
	try {
		const text = await readFile(readingOpeningPath(learnerId, genreId), "utf8");
		const opening = JSON.parse(text) as PreparedReadingOpening;
		// The queue is a cache, not history: an entry written before stories were
		// generated whole holds only a frame, so drop it and prepare a real one.
		return isCompleteReadingStory(opening?.readingStory) ? opening : null;
	} catch {
		return null;
	}
}

function isCompleteReadingStory(story: unknown): story is ReadingStory {
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
		typeof readingStory.visualContext === "string" &&
		Boolean(readingStory.visualContext.trim()) &&
		Array.isArray(parts) &&
		parts.length >= 2 &&
		parts.length <= READING_STORY_MAX_PARTS &&
		parts.every((part) => Boolean(part?.text?.trim())) &&
		Array.isArray(readingStory.properNames) &&
		Array.isArray(readingStory.imagePrompts) &&
		readingStory.imagePrompts.length ===
			readingImageParts(parts.length).length &&
		readingStory.imagePrompts.every((prompt) => Boolean(prompt?.trim()))
	);
}

async function writePreparedReadingOpening(
	learnerId: string,
	opening: PreparedReadingOpening,
) {
	await mkdir(learnerReadingOpeningsDir(learnerId), { recursive: true });
	await writeFile(
		readingOpeningPath(learnerId, opening.genreId),
		`${JSON.stringify(opening, null, 2)}\n`,
		"utf8",
	);
}

function readingOpeningPath(learnerId: string, genreId: LanguageId) {
	return join(learnerReadingOpeningsDir(learnerId), `${genreId}.json`);
}

function fallbackBackgroundUrl(genreId: LanguageId) {
	return languageHeroImageUrl(getLanguage(genreId));
}

function imageFilename(genre: Language, sectionIndex?: number) {
	if (sectionIndex !== undefined) return `section_${sectionIndex}.webp`;
	return `${genre.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;
}

function imagePath(storyId: string, filename: string) {
	if (bundleIdPattern.test(storyId))
		return bundledImagesPath(storyId, filename);
	return join(storyImagesDir, storyId, filename);
}
