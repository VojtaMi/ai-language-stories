import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type OpenAI from "openai";
import {
	getLanguage,
	type LanguageId,
	languageTtsInstructions,
} from "../languages";
import { tts } from "./tts";
import type { GeminiTtsModel } from "./tts/constants";
import type { SynthesizedSpeech } from "./tts/types";

const wordAudioDir = join(process.cwd(), "word-audio");

export const wordFilePattern = /^\p{L}+(?:[-’']\p{L}+)*\.(mp3|wav)$/u;

function wordAudioUrl(
	genreId: LanguageId,
	word: string,
	version: number,
): string {
	return `/api/word-audio/${genreId}/${encodeURIComponent(word)}?v=${version}`;
}

function preferredWordAudioFilename(word: string): string {
	return `${word}.${process.env.GEMINI_API_KEY ? "wav" : "mp3"}`;
}

async function findCachedWordAudio(genreId: LanguageId, filenames: string[]) {
	for (const filename of filenames) {
		try {
			const file = await stat(join(wordAudioDir, genreId, filename));
			return { filename, mtimeMs: file.mtimeMs };
		} catch {
			// Try the next cache format.
		}
	}
	return null;
}

function allWordAudioFilenames(word: string): string[] {
	const preferredFilename = preferredWordAudioFilename(word);
	return [
		preferredFilename,
		...[`${word}.wav`, `${word}.mp3`].filter(
			(filename) => filename !== preferredFilename,
		),
	];
}

function wordAudioMimeType(filename: string): SynthesizedSpeech["mimeType"] {
	return filename.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
}

async function synthesizeWordAudio(
	openai: OpenAI,
	genreId: LanguageId,
	word: string,
	geminiModel: GeminiTtsModel,
): Promise<string> {
	const genre = getLanguage(genreId);
	const speech = await tts({
		openai,
		text: word,
		provider: "gemini",
		geminiModel,
		instructions: `Pronounce this single ${genre.label} word clearly, slowly, and in isolation — as if teaching a language learner. ${languageTtsInstructions(genre)}`,
	});
	await mkdir(join(wordAudioDir, genreId), { recursive: true });
	await writeFile(
		join(wordAudioDir, genreId, `${word}.${speech.extension}`),
		speech.audio,
	);
	return wordAudioUrl(genreId, word, Date.now());
}

export async function getOrCreateWordAudio(
	openai: OpenAI,
	genreId: LanguageId,
	word: string,
): Promise<string> {
	const cached = await findCachedWordAudio(genreId, [
		preferredWordAudioFilename(word),
	]);
	if (cached) {
		console.log(`[word-audio] HIT  ${word}`);
		return wordAudioUrl(genreId, word, Math.floor(cached.mtimeMs));
	}

	console.log(`[word-audio] MISS ${word} — calling TTS`);
	return synthesizeWordAudio(
		openai,
		genreId,
		word,
		"gemini-3.8-flash-lite-tts",
	);
}

export async function regenerateWordAudio(
	openai: OpenAI,
	genreId: LanguageId,
	word: string,
): Promise<string> {
	for (const extension of ["wav", "mp3"]) {
		try {
			await unlink(join(wordAudioDir, genreId, `${word}.${extension}`));
		} catch {
			// Missing cached audio is fine; regeneration should still create it.
		}
	}
	console.log(`[word-audio] REGEN ${word} — calling TTS`);
	// Explicit regeneration tries Flash after an unsatisfactory initial sample.
	return synthesizeWordAudio(openai, genreId, word, "gemini-3.8-flash-tts");
}

export async function readWordAudio(
	genreId: LanguageId,
	word: string,
): Promise<{ audio: Buffer; mimeType: SynthesizedSpeech["mimeType"] }> {
	const cached = await findCachedWordAudio(
		genreId,
		allWordAudioFilenames(word),
	);
	if (!cached) {
		throw new Error("Audio not found.");
	}
	return {
		audio: await readFile(join(wordAudioDir, genreId, cached.filename)),
		mimeType: wordAudioMimeType(cached.filename),
	};
}
