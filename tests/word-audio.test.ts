import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type OpenAI from "openai";

const directory = await mkdtemp(join(tmpdir(), "word-audio-test-"));
const originalCwd = process.cwd();
process.chdir(directory);
const { handleWordAudioRequest } = await import(
	"../src/server/aiEndpointHandlers.ts"
);
const { queueWordAudioPrewarm, readWordAudio, regenerateWordAudio } =
	await import("../src/server/wordAudioStore.ts");
const { splitWordRecording } = await import("../src/server/tts/splitWords.ts");
const { pcmToWav, readWav } = await import("../src/server/tts/wav.ts");
process.chdir(originalCwd);

const originalFetch = globalThis.fetch;
const originalGeminiKey = process.env.GEMINI_API_KEY;
const originalOpenaiKey = process.env.OPENAI_API_KEY;
const wav = Buffer.from("RIFFtestWAVE");
const mp3 = Buffer.from("test mp3 recording");
let calls = 0;
let expectedModel = "";
let expectedPronunciation = "restored Classical Latin";
process.env.GEMINI_API_KEY = "test-key";
process.env.OPENAI_API_KEY = "test-key";
const openai = {
	audio: {
		speech: {
			create: async (body: { model: string }) => {
				calls += 1;
				assert.equal(body.model, expectedModel);
				return new Response(mp3);
			},
		},
	},
} as unknown as OpenAI;

async function request(word: string, ttsModel: string, genreId = "latin") {
	let responseBody = "";
	const req = Readable.from([
		JSON.stringify({ genreId, word, ttsModel }),
	]) as IncomingMessage;
	const res = {
		statusCode: 0,
		setHeader: () => {},
		end: (body: string) => {
			responseBody = body;
		},
	} as unknown as ServerResponse;
	await handleWordAudioRequest(req, res, openai);
	assert.equal(res.statusCode, 200);
	assert.ok(
		JSON.parse(responseBody).url.startsWith(`/api/word-audio/${genreId}/`),
	);
}

try {
	globalThis.fetch = async (url, init) => {
		calls += 1;
		assert.ok(String(url).includes(`/${expectedModel}:generateContent`));
		const body = JSON.parse(String(init?.body));
		assert.ok(
			body.contents[0].parts[0].speech_metadata.style.includes(
				expectedPronunciation,
			),
		);
		return Response.json({
			candidates: [
				{
					content: {
						parts: [
							{
								inlineData: {
									data: wav.toString("base64"),
									mimeType: "audio/wav",
								},
							},
						],
					},
				},
			],
		});
	};
	for (const [selection, model, word] of [
		["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-lite-tts", "vinum"],
		["gemini-3.8-flash-tts", "gemini-3.8-flash-tts", "cicero"],
		["openai", "gpt-4o-mini-tts", "caesar"],
		["invalid-model", "gemini-3.8-flash-lite-tts", "hortus"],
	]) {
		expectedModel = model;
		const before = calls;
		await request(word.toUpperCase(), selection);
		assert.equal(calls, before + 1);
		const file = await readWordAudio("latin", word);
		assert.deepEqual(file.audio, selection === "openai" ? mp3 : wav);
		assert.equal(
			file.mimeType,
			selection === "openai" ? "audio/mpeg" : "audio/wav",
		);
		// Initial generation follows the setting; existing word audio remains shared.
		await request(word, "gemini-3.8-flash-tts");
		assert.equal(calls, before + 1);
	}
	expectedModel = "gemini-3.8-flash-tts";
	const before = calls;
	await regenerateWordAudio(openai, "latin", "caesar");
	assert.equal(calls, before + 1);
	assert.deepEqual((await readWordAudio("latin", "caesar")).audio, wav);
	expectedPronunciation = "Roman Ecclesiastical Latin";
	await request("vinum", "gemini-3.8-flash-tts", "latin-ecclesiastical");
	assert.equal(calls, before + 2);
	assert.deepEqual(
		(await readWordAudio("latin-ecclesiastical", "vinum")).audio,
		wav,
	);
	console.log(
		"Word audio: selected model, provider, defaults, cache reuse, and Flash regeneration passed.",
	);

	// A synthetic recording: tones for words, silence for pauses.
	const sampleRate = 24_000;
	const recording = (parts: [kind: "tone" | "quiet", seconds: number][]) => {
		const samples = parts.flatMap(([kind, seconds]) =>
			Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) =>
				kind === "tone" ? Math.round(Math.sin(i / 8) * 12_000) : 0,
			),
		);
		const pcm = Buffer.alloc(samples.length * 2);
		samples.forEach((sample, i) => {
			pcm.writeInt16LE(sample, i * 2);
		});
		return pcm;
	};
	const threeWords = recording([
		["quiet", 0.3],
		["tone", 0.4],
		["quiet", 1],
		// A short gap inside a word must not split it.
		["tone", 0.3],
		["quiet", 0.15],
		["tone", 0.3],
		["quiet", 1],
		["tone", 0.3],
		["quiet", 0.8],
		// A trailing breath is not a word.
		["tone", 0.1],
		["quiet", 0.3],
	]);
	const clips = splitWordRecording(threeWords, sampleRate, 3);
	assert.equal(clips?.length, 3);
	// Each clip keeps 60 ms of padding on both sides of its word.
	assert.ok(Math.abs((clips?.[1].length ?? 0) / 2 / sampleRate - 0.87) < 0.03);
	assert.equal(splitWordRecording(threeWords, sampleRate, 4), null);
	const parsed = readWav(pcmToWav(threeWords, sampleRate));
	assert.equal(parsed?.sampleRate, sampleRate);
	assert.deepEqual(parsed?.pcm, threeWords);

	// Story preparation generates each section's words in one batched request.
	let batchResponse = pcmToWav(threeWords, sampleRate);
	let batchStatus = 200;
	let batchCalls = 0;
	globalThis.fetch = async (_url, init) => {
		batchCalls += 1;
		const text = JSON.parse(String(init?.body)).contents[0].parts[0].text;
		assert.match(text, /^[A-ZÄÖÜ][^\n]*\.(\n[A-ZÄÖÜ][^\n]*\.)*$/u);
		if (batchStatus === 429) {
			return Response.json(
				{ error: { message: "Quota exceeded, limit: 10" } },
				{ status: 429, statusText: "Too Many Requests" },
			);
		}
		return Response.json({
			candidates: [
				{
					content: {
						parts: [
							{
								inlineData: {
									data: batchResponse.toString("base64"),
									mimeType: "audio/wav",
								},
							},
						],
					},
				},
			],
		});
	};
	await queueWordAudioPrewarm(
		openai,
		"german",
		[["korb", "dorf", "baum"], []],
		"gemini-3.8-flash-lite-tts",
	);
	assert.equal(batchCalls, 1);
	for (const [i, word] of ["korb", "dorf", "baum"].entries()) {
		const file = await readWordAudio("german", word);
		assert.equal(file.mimeType, "audio/wav");
		assert.deepEqual(readWav(file.audio)?.pcm, clips?.[i]);
	}

	// A recording that does not split into its words saves nothing.
	batchResponse = pcmToWav(recording([["tone", 0.5]]), sampleRate);
	await queueWordAudioPrewarm(
		openai,
		"german",
		[["wald", "haus", "wind"]],
		"gemini-3.8-flash-lite-tts",
	);
	await assert.rejects(readWordAudio("german", "wald"));

	// A rate limit stops pre-generation quietly; clicks still generate words.
	batchStatus = 429;
	const callsBefore = batchCalls;
	await queueWordAudioPrewarm(
		openai,
		"german",
		[["tisch"], ["stuhl"]],
		"gemini-3.8-flash-lite-tts",
	);
	assert.equal(batchCalls, callsBefore + 1);
	await assert.rejects(readWordAudio("german", "tisch"));
	console.log(
		"Word audio batches: splitting, per-section requests, mismatch and rate-limit fallbacks passed.",
	);
} finally {
	globalThis.fetch = originalFetch;
	if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
	else process.env.GEMINI_API_KEY = originalGeminiKey;
	if (originalOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = originalOpenaiKey;
	await rm(directory, { recursive: true, force: true });
}
