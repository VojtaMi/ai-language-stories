import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type OpenAI from "openai";
import {
	type NarrationVoiceId,
	narrationVoiceOptions,
} from "../narrationVoice";
import type {
	DialogueQuotes,
	SectionDialogue,
} from "../reading_story/dialogue";
import type { NarrationSegment, StoryOpeningAudio } from "../storyAudio";
import {
	DEFAULT_TTS_MODEL,
	TTS_MODELS,
	type TtsModelId,
	ttsModelInfo,
	ttsModelSpeechOptions,
} from "../ttsModel";
import { HttpError } from "./http";
import {
	bundledAudioPath,
	bundleIdPattern,
	pathExists,
} from "./storyBundleStore";
import { type GeminiTtsModel, tts } from "./tts";
import {
	dialogueTurns,
	synthesizeGeminiDialogue,
} from "./tts/geminiDialogueTts";
import { geminiVoice } from "./tts/voices";

const storyAudioDir = join(process.cwd(), "story-audio");

export const audioFilePattern = /^[a-zA-Z0-9_-]+\.(mp3|wav)$/;

export async function createOpeningAudio(
	openai: OpenAI,
	text: string,
	storyId: string,
	narrationVoice: NarrationVoiceId,
	options: {
		sectionIndex?: number;
		ttsModel?: TtsModelId;
		instructions?: string;
		/** Runs just before a paid TTS call; may throw to refuse it. */
		beforeProviderCall?: () => void;
		/** Attributed speech in this section; voiced per character with Gemini. */
		dialogue?: { quotes: DialogueQuotes; section: SectionDialogue };
	} = {},
): Promise<StoryOpeningAudio | null> {
	const ttsModel = options.ttsModel ?? DEFAULT_TTS_MODEL;
	const modelInfo = ttsModelInfo(ttsModel);
	// Only Gemini can give each speaker a voice; other providers narrate alone.
	const dialogue =
		modelInfo.provider === "gemini" && process.env.GEMINI_API_KEY?.trim()
			? options.dialogue
			: undefined;
	// The cast is part of the recording's identity, so a single-voice
	// recording of the same text is never mistaken for a voiced one.
	const audioKey = dialogue
		? `${text}\n${JSON.stringify(dialogue.section)}`
		: text;
	try {
		const existingAudio = await findExistingSectionAudio(
			text,
			audioKey,
			storyId,
			narrationVoice,
			ttsModel,
			options.sectionIndex,
		);
		if (existingAudio) return existingAudio;

		options.beforeProviderCall?.();
		const speech = dialogue
			? await synthesizeGeminiDialogue(
					modelInfo.model as GeminiTtsModel,
					dialogueTurns(
						text,
						dialogue.quotes,
						dialogue.section,
						geminiVoice(narrationVoice),
						options.instructions ?? "",
					),
					text.length,
				)
			: await tts({
					openai,
					text,
					instructions: options.instructions,
					...narrationVoiceOptions(narrationVoice),
					...ttsModelSpeechOptions(ttsModel),
				});
		const filename = audioFilename(
			audioKey,
			narrationVoice,
			speech.model,
			speech.extension,
			options.sectionIndex,
		);
		const filePath = audioPath(storyId, filename);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, speech.audio);
		if (speech.segments) {
			await writeFile(segmentsPath(filePath), JSON.stringify(speech.segments));
		}
		return {
			openingAudioUrl: `/api/story-audio/${storyId}/${filename}`,
			openingAudioSource: "generated",
			openingAudioText: text,
			openingAudioTextHash: audioTextHash(text),
			openingAudioVoice: narrationVoice,
			openingAudioProvider: speech.provider,
			openingAudioModel: speech.model,
			openingAudioMimeType: speech.mimeType,
			...(speech.segments ? { openingAudioSegments: speech.segments } : {}),
		};
	} catch (err) {
		// A refusal (such as a rate limit) belongs to the caller, not to a
		// provider failure that degrades to "no narration".
		if (err instanceof HttpError) throw err;
		console.warn("Could not generate opening audio.", err);
		return null;
	}
}

/**
 * A section is narrated once. The selected model decides what gets generated
 * next, not whether narration that already exists is usable — so the requested
 * model is tried first and any other model's recording of the same section, in
 * the same voice, of the same exact text is accepted after it. Insisting on an
 * exact model match instead costs a paid call per section every time the
 * selection differs from what is on disk, which a browser with no stored
 * selection does by default, and leaves one story speaking in two models.
 */
async function findExistingSectionAudio(
	text: string,
	audioKey: string,
	storyId: string,
	narrationVoice: NarrationVoiceId,
	ttsModel: TtsModelId,
	sectionIndex?: number,
): Promise<StoryOpeningAudio | null> {
	if (sectionIndex === undefined) return null;

	const candidates: TtsModelId[] = [
		ttsModel,
		...TTS_MODELS.map((model) => model.id).filter((id) => id !== ttsModel),
	];

	for (const candidate of candidates) {
		const provider = ttsModelInfo(candidate);
		const filename = audioFilename(
			audioKey,
			narrationVoice,
			provider.model,
			provider.extension,
			sectionIndex,
		);
		const filePath = audioPath(storyId, filename);
		if (!(await pathExists(filePath))) continue;
		const segments = await readSegments(filePath);

		return {
			openingAudioUrl: `/api/story-audio/${storyId}/${filename}`,
			openingAudioSource: "generated",
			openingAudioText: text,
			openingAudioTextHash: audioTextHash(text),
			openingAudioVoice: narrationVoice,
			openingAudioProvider: provider.provider,
			openingAudioModel: provider.model,
			openingAudioMimeType: provider.mimeType,
			...(segments ? { openingAudioSegments: segments } : {}),
		};
	}
	return null;
}

/** Request boundaries of a stitched recording live beside it. */
function segmentsPath(audioFilePath: string) {
	return `${audioFilePath}.segments.json`;
}

async function readSegments(
	audioFilePath: string,
): Promise<NarrationSegment[] | undefined> {
	try {
		return JSON.parse(
			await readFile(segmentsPath(audioFilePath), "utf8"),
		) as NarrationSegment[];
	} catch {
		return undefined;
	}
}

export async function readStoryAudio(relativePath: string) {
	const [storyId, filename] = relativePath.split("/");
	if (storyId && filename) {
		const bundled = bundledAudioPath(storyId, filename);
		if (await pathExists(bundled)) return readFile(bundled);
	}
	return readFile(join(storyAudioDir, relativePath));
}

/** `audioKey` is the narrated text, plus the cast when voiced per character. */
function audioFilename(
	audioKey: string,
	voice: NarrationVoiceId,
	model: string,
	extension: "mp3" | "wav",
	sectionIndex?: number,
) {
	if (sectionIndex !== undefined) {
		const modelToken = model.replace(/[^a-zA-Z0-9_-]/g, "");
		return `section_${sectionIndex}_${voice}_${modelToken}_${audioTextHash(audioKey)}.${extension}`;
	}
	return `opening-${audioTextHash(audioKey)}-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
}

function audioPath(storyId: string, filename: string) {
	if (bundleIdPattern.test(storyId)) return bundledAudioPath(storyId, filename);
	return join(storyAudioDir, storyId, filename);
}

function audioTextHash(text: string) {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
