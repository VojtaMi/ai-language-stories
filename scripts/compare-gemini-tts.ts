import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { GEMINI_TTS_MODELS } from "../src/server/tts/constants.ts";

type StoryRecord = {
	id?: string;
	segments?: Array<{
		text?: string;
	}>;
};

type GeminiGenerateContentResponse = {
	candidates?: Array<{
		content?: {
			parts?: Array<{
				inlineData?: {
					data?: string;
					mimeType?: string;
				};
			}>;
		};
	}>;
};

const DEFAULT_VOICE = "Kore";
const MODELS = GEMINI_TTS_MODELS;
const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

const apiKey = process.env.GEMINI_API_KEY ?? "";
if (!apiKey) {
	console.error("Error: GEMINI_API_KEY is required in .env.local.");
	process.exit(1);
}

const storyPath = process.argv[2];
if (!storyPath) {
	throw new Error(
		"Usage: compare-gemini-tts.ts <browser-story-json> [section] [voice]",
	);
}
const sectionNumber = parseSectionNumber(process.argv[3] ?? "1");
const voiceName = process.argv[4] ?? DEFAULT_VOICE;

const story = JSON.parse(await readFile(storyPath, "utf8")) as StoryRecord;
const text = story.segments?.[sectionNumber - 1]?.text?.trim();
if (!text) {
	console.error(
		`Error: could not find text for section ${sectionNumber} in ${storyPath}.`,
	);
	process.exit(1);
}

const storyId = story.id ?? basename(dirname(storyPath));
const outputDir = join("story-audio", "gemini-tts-comparisons", storyId);
await mkdir(outputDir, { recursive: true });

console.log(`Section: ${sectionNumber}`);
console.log(`Characters: ${text.length}`);
console.log(`Voice: ${voiceName}\n`);

for (const model of MODELS) {
	const started = Date.now();
	const pcm = await generateGeminiTts({ apiKey, model, text, voiceName });
	const elapsedMs = Date.now() - started;
	const wav = pcmToWav(pcm);

	const outputPath = join(
		outputDir,
		`section_${sectionNumber}_${modelSlug(model)}_${voiceName.toLowerCase()}.wav`,
	);
	await writeFile(outputPath, wav);

	console.log(`Model: ${model}`);
	console.log(`  File: ${outputPath}`);
	console.log(`  Latency: ${elapsedMs}ms`);
	console.log(`  Audio bytes: ${wav.length}\n`);
}

async function generateGeminiTts({
	apiKey,
	model,
	text,
	voiceName,
}: {
	apiKey: string;
	model: string;
	text: string;
	voiceName: string;
}): Promise<Buffer> {
	const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-goog-api-key": apiKey,
		},
		body: JSON.stringify({
			contents: [
				{
					parts: [
						{
							text: `Read this Esperanto beginner story section aloud slowly and clearly, with natural pauses. Recite only the passage:\n\n${text}`,
						},
					],
				},
			],
			generationConfig: {
				responseModalities: ["AUDIO"],
				speechConfig: {
					voiceConfig: {
						prebuiltVoiceConfig: { voiceName },
					},
				},
			},
		}),
	});

	if (!response.ok) {
		throw new Error(
			`Gemini TTS request failed for ${model}: ${response.status} ${response.statusText}\n${await response.text()}`,
		);
	}

	const json = (await response.json()) as GeminiGenerateContentResponse;
	const inlineData = json.candidates?.[0]?.content?.parts?.find(
		(part) => part.inlineData,
	)?.inlineData;
	if (!inlineData?.data) {
		throw new Error(
			`Gemini TTS response for ${model} did not include audio data.`,
		);
	}

	if (
		inlineData.mimeType &&
		!inlineData.mimeType.includes("audio") &&
		!inlineData.mimeType.includes("octet-stream")
	) {
		throw new Error(
			`Unexpected Gemini TTS MIME type for ${model}: ${inlineData.mimeType}`,
		);
	}

	return Buffer.from(inlineData.data, "base64");
}

function parseSectionNumber(value: string): number {
	const sectionNumber = Number.parseInt(value, 10);
	if (!Number.isInteger(sectionNumber) || sectionNumber < 1) {
		console.error("Error: section number must be a positive integer.");
		process.exit(1);
	}
	return sectionNumber;
}

function modelSlug(model: string): string {
	return model.replace(/^gemini-/, "gemini_").replace(/[.-]/g, "_");
}

function pcmToWav(pcm: Buffer): Buffer {
	const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
	const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
	const header = Buffer.alloc(44);

	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(BITS_PER_SAMPLE, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);

	return Buffer.concat([header, pcm]);
}
