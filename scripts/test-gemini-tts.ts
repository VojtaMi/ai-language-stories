import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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

const DEFAULT_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_VOICE = "Kore";
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
		"Usage: test-gemini-tts.ts <browser-story-json> [section] [voice] [model]",
	);
}
const sectionNumber = parseSectionNumber(process.argv[3] ?? "1");
const voiceName = process.argv[4] ?? DEFAULT_VOICE;
const model = process.argv[5] ?? DEFAULT_MODEL;

const story = JSON.parse(await readFile(storyPath, "utf8")) as StoryRecord;
const text = story.segments?.[sectionNumber - 1]?.text?.trim();
if (!text) {
	console.error(
		`Error: could not find text for section ${sectionNumber} in ${storyPath}.`,
	);
	process.exit(1);
}

const pcm = await generateGeminiTts({
	apiKey,
	model,
	text,
	voiceName,
});
const wav = pcmToWav(pcm);

const storyId = story.id ?? basename(dirname(storyPath));
const outputDir = join("story-audio", "gemini-tests", storyId);
const outputPath = join(
	outputDir,
	`section_${sectionNumber}_gemini_${voiceName.toLowerCase()}.wav`,
);

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, wav);

console.log(`Generated Gemini TTS sample: ${outputPath}`);
console.log(`Model: ${model}`);
console.log(`Voice: ${voiceName}`);
console.log(`Section: ${sectionNumber}`);
console.log(`Characters: ${text.length}`);

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
			`Gemini TTS request failed: ${response.status} ${response.statusText}\n${await response.text()}`,
		);
	}

	const json = (await response.json()) as GeminiGenerateContentResponse;
	const inlineData = json.candidates?.[0]?.content?.parts?.find(
		(part) => part.inlineData,
	)?.inlineData;
	if (!inlineData?.data) {
		throw new Error("Gemini TTS response did not include audio data.");
	}

	if (
		inlineData.mimeType &&
		!inlineData.mimeType.includes("audio") &&
		!inlineData.mimeType.includes("octet-stream")
	) {
		throw new Error(`Unexpected Gemini TTS MIME type: ${inlineData.mimeType}`);
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
