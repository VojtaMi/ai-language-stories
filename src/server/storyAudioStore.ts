import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type OpenAI from "openai";
import {
	type NarrationVoiceId,
	narrationVoiceOptions,
} from "../narrationVoice";
import type { StoryOpeningAudio } from "../storyAudio";
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
import { tts } from "./tts";

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
	} = {},
): Promise<StoryOpeningAudio | null> {
	const ttsModel = options.ttsModel ?? DEFAULT_TTS_MODEL;
	try {
		const existingAudio = await findExistingSectionAudio(
			text,
			storyId,
			narrationVoice,
			ttsModel,
			options.sectionIndex,
		);
		if (existingAudio) return existingAudio;

		options.beforeProviderCall?.();
		const speech = await tts({
			openai,
			text,
			instructions: options.instructions,
			...narrationVoiceOptions(narrationVoice),
			...ttsModelSpeechOptions(ttsModel),
		});
		const filename = audioFilename(
			text,
			narrationVoice,
			speech.model,
			speech.extension,
			options.sectionIndex,
		);
		const filePath = audioPath(storyId, filename);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, speech.audio);
		return {
			openingAudioUrl: `/api/story-audio/${storyId}/${filename}`,
			openingAudioSource: "generated",
			openingAudioText: text,
			openingAudioTextHash: audioTextHash(text),
			openingAudioVoice: narrationVoice,
			openingAudioProvider: speech.provider,
			openingAudioModel: speech.model,
			openingAudioMimeType: speech.mimeType,
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
			text,
			narrationVoice,
			provider.model,
			provider.extension,
			sectionIndex,
		);
		if (!(await pathExists(audioPath(storyId, filename)))) continue;

		return {
			openingAudioUrl: `/api/story-audio/${storyId}/${filename}`,
			openingAudioSource: "generated",
			openingAudioText: text,
			openingAudioTextHash: audioTextHash(text),
			openingAudioVoice: narrationVoice,
			openingAudioProvider: provider.provider,
			openingAudioModel: provider.model,
			openingAudioMimeType: provider.mimeType,
		};
	}
	return null;
}

export async function readStoryAudio(relativePath: string) {
	const [storyId, filename] = relativePath.split("/");
	if (storyId && filename) {
		const bundled = bundledAudioPath(storyId, filename);
		if (await pathExists(bundled)) return readFile(bundled);
	}
	return readFile(join(storyAudioDir, relativePath));
}

function audioFilename(
	text: string,
	voice: NarrationVoiceId,
	model: string,
	extension: "mp3" | "wav",
	sectionIndex?: number,
) {
	if (sectionIndex !== undefined) {
		const modelToken = model.replace(/[^a-zA-Z0-9_-]/g, "");
		return `section_${sectionIndex}_${voice}_${modelToken}_${audioTextHash(text)}.${extension}`;
	}
	return `opening-${audioTextHash(text)}-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
}

function audioPath(storyId: string, filename: string) {
	if (bundleIdPattern.test(storyId)) return bundledAudioPath(storyId, filename);
	return join(storyAudioDir, storyId, filename);
}

function audioTextHash(text: string) {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
