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
const { readWordAudio, regenerateWordAudio } = await import(
	"../src/server/wordAudioStore.ts"
);
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
} finally {
	globalThis.fetch = originalFetch;
	if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
	else process.env.GEMINI_API_KEY = originalGeminiKey;
	if (originalOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = originalOpenaiKey;
	await rm(directory, { recursive: true, force: true });
}
