import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type OpenAI from "openai";
import {
	getLanguage,
	type LanguageId,
	languageTtsInstructions,
} from "../languages";
import {
	type TtsModelId,
	ttsModelInfo,
	ttsModelSpeechOptions,
} from "../ttsModel";
import { tts } from "./tts";
import { isGeminiTtsRateLimit } from "./tts/geminiTts";
import { splitWordRecording } from "./tts/splitWords";
import type { SynthesizedSpeech } from "./tts/types";
import { pcmToWav, readWav } from "./tts/wav";

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
	ttsModel: TtsModelId,
): Promise<string> {
	const genre = getLanguage(genreId);
	const speech = await tts({
		openai,
		text: word,
		...ttsModelSpeechOptions(ttsModel),
		instructions: `Pronounce this single ${genre.label} word clearly, slowly, and in isolation — as if teaching a language learner. ${languageTtsInstructions(genre)}`,
	});
	await mkdir(join(wordAudioDir, genreId), { recursive: true });
	await writeFile(
		join(wordAudioDir, genreId, `${word}.${speech.extension}`),
		speech.audio,
	);
	return wordAudioUrl(genreId, word, Date.now());
}

/** Concurrent misses for one word (a double tap) share one TTS call. */
const pendingWordAudio = new Map<string, Promise<string>>();

export async function getOrCreateWordAudio(
	openai: OpenAI,
	genreId: LanguageId,
	word: string,
	ttsModel: TtsModelId,
	beforeProviderCall?: () => void,
): Promise<string> {
	const cached = await findCachedWordAudio(
		genreId,
		allWordAudioFilenames(word),
	);
	if (cached) {
		console.log(`[word-audio] HIT  ${word}`);
		return wordAudioUrl(genreId, word, Math.floor(cached.mtimeMs));
	}

	const key = `${genreId}/${word}`;
	// A click during story preparation waits for the batch that is already
	// generating this word instead of paying for it twice.
	const batched = await batchedWordAudio.get(key);
	if (batched) return batched;
	const pending = pendingWordAudio.get(key);
	if (pending) return pending;
	beforeProviderCall?.();
	console.log(`[word-audio] MISS ${word} — calling TTS`);
	const request = synthesizeWordAudio(openai, genreId, word, ttsModel).finally(
		() => pendingWordAudio.delete(key),
	);
	pendingWordAudio.set(key, request);
	return request;
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

/** Words a running batch will produce, resolving to their URL or null if it fails. */
const batchedWordAudio = new Map<string, Promise<string | null>>();

/** A section rarely has more new words; past this a batch is split, as long lists drift. */
const MAX_WORD_BATCH = 40;
/**
 * Background batches stay at ≤6 requests a minute, leaving the TTS quota to
 * the narration and clicks a learner is waiting for.
 */
const WORD_BATCH_SPACING_MS = 10_000;

/** One queue for every story being prepared, so their requests never add up. */
let wordBatchQueue: Promise<void> = Promise.resolve();

/**
 * Generates a story's word pronunciations ahead of clicks: one recording per
 * section, in reading order, cut into words at the pauses between them. Only
 * Gemini returns PCM that can be cut; other providers keep on-click audio.
 */
export function queueWordAudioPrewarm(
	openai: OpenAI,
	genreId: LanguageId,
	sectionWords: string[][],
	ttsModel: TtsModelId,
): Promise<void> {
	if (
		ttsModelInfo(ttsModel).provider !== "gemini" ||
		!process.env.GEMINI_API_KEY?.trim()
	) {
		return wordBatchQueue;
	}
	wordBatchQueue = wordBatchQueue
		.then(() => prewarmSectionWords(openai, genreId, sectionWords, ttsModel))
		.catch((err) => console.warn("[word-audio] BATCH prewarm failed.", err));
	return wordBatchQueue;
}

async function prewarmSectionWords(
	openai: OpenAI,
	genreId: LanguageId,
	sectionWords: string[][],
	ttsModel: TtsModelId,
) {
	const batches: string[][] = [];
	for (const words of sectionWords) {
		const missing: string[] = [];
		for (const word of words) {
			if (
				wordFilePattern.test(`${word}.wav`) &&
				!(await findCachedWordAudio(genreId, allWordAudioFilenames(word)))
			) {
				missing.push(word);
			}
		}
		const parts = Math.ceil(missing.length / MAX_WORD_BATCH);
		for (let i = 0; i < parts; i++) {
			const size = Math.ceil(missing.length / parts);
			batches.push(missing.slice(i * size, (i + 1) * size));
		}
	}

	for (const [index, words] of batches.entries()) {
		if (index > 0) await sleep(WORD_BATCH_SPACING_MS);
		const keys = words.map((word) => `${genreId}/${word}`);
		const run = synthesizeWordBatch(openai, genreId, words, ttsModel);
		words.forEach((_, i) => {
			batchedWordAudio.set(
				keys[i],
				run.then(
					(urls) => urls?.[i] ?? null,
					() => null,
				),
			);
		});
		try {
			await run;
		} catch (err) {
			if (isGeminiTtsRateLimit(err)) {
				console.warn(
					`[word-audio] BATCH ${genreId}: rate limited, leaving the rest to clicks.`,
					err instanceof Error ? err.message : err,
				);
				return;
			}
			console.warn(`[word-audio] BATCH ${genreId} failed.`, err);
		} finally {
			for (const key of keys) batchedWordAudio.delete(key);
		}
	}
}

async function synthesizeWordBatch(
	openai: OpenAI,
	genreId: LanguageId,
	words: string[],
	ttsModel: TtsModelId,
): Promise<string[] | null> {
	const genre = getLanguage(genreId);
	console.log(`[word-audio] BATCH ${genreId}: ${words.length} words`);
	// One word per line, as its own sentence, so each is read in isolation.
	const speech = await tts({
		openai,
		text: words
			.map((word) => `${word[0].toUpperCase()}${word.slice(1)}.`)
			.join("\n"),
		...ttsModelSpeechOptions(ttsModel),
		instructions: [
			`Each line is one separate single ${genre.label} word. Pronounce each word clearly and slowly, in isolation, as if teaching a language learner.`,
			"Say every word with the same calm, finished intonation it would have if it were the only word — not like an item in a list.",
			"Leave a full pause of about one second of silence after each word. Read nothing except the words.",
			languageTtsInstructions(genre),
		].join(" "),
	});
	const recording = readWav(speech.audio);
	const clips =
		recording &&
		splitWordRecording(recording.pcm, recording.sampleRate, words.length);
	if (!recording || !clips) {
		console.warn(
			`[word-audio] BATCH ${genreId}: the recording did not split into ${words.length} words; they stay on-click.`,
		);
		return null;
	}
	await mkdir(join(wordAudioDir, genreId), { recursive: true });
	await Promise.all(
		clips.map((clip, i) =>
			writeFile(
				join(wordAudioDir, genreId, `${words[i]}.wav`),
				pcmToWav(clip, recording.sampleRate),
			),
		),
	);
	const version = Date.now();
	return words.map((word) => wordAudioUrl(genreId, word, version));
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
