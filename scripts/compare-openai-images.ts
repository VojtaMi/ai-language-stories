import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { languages } from "../src/languages.ts";
import { buildStoryBackgroundPrompt } from "../src/server/images/prompts.ts";
import type { ReadingStory } from "../src/story.ts";

const MODELS = [
	"gpt-image-2",
	"gpt-image-2.5-flare",
	"gpt-image-2.5-sunburst",
] as const;

type ImageResponse = {
	data?: Array<{ b64_json?: string }>;
	usage?: unknown;
};

type StoryRecord = {
	genreId?: string;
	id?: string;
	imagePrompts?: string[];
	parts?: Array<{ text?: string }>;
	readingStory?: Pick<ReadingStory, "imagePrompts" | "parts" | "visualContext">;
	segments?: Array<{ text?: string }>;
	visualContext?: string;
};

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) {
	console.error("Error: OPENAI_API_KEY is required in .env.local.");
	process.exit(1);
}

const storyPath = process.argv[2];
if (!storyPath) {
	throw new Error(
		"Usage: compare-openai-images.ts <browser-story-json> [section] [reference-image]",
	);
}
const sectionNumber = parseSectionNumber(process.argv[3] ?? "1");
const referencePath = process.argv[4];
const referenceImage = referencePath
	? await readFile(referencePath)
	: undefined;
const story = JSON.parse(await readFile(storyPath, "utf8")) as StoryRecord;
const genre = languages.find((candidate) => candidate.id === story.genreId);
if (!genre) {
	throw new Error(`Unknown or missing genreId in ${storyPath}.`);
}
const imagePromptIndex = Math.floor((sectionNumber - 1) / 2);
const storyText =
	story.readingStory?.imagePrompts[imagePromptIndex]?.trim() ??
	story.imagePrompts?.[imagePromptIndex]?.trim() ??
	story.segments?.[sectionNumber - 1]?.text?.trim() ??
	story.readingStory?.parts[sectionNumber - 1]?.text?.trim() ??
	story.parts?.[sectionNumber - 1]?.text?.trim();
if (!storyText) {
	throw new Error(
		`Could not find story text for section ${sectionNumber} in ${storyPath}.`,
	);
}

const prompt = buildStoryBackgroundPrompt(
	genre,
	storyText,
	story.readingStory?.visualContext ?? story.visualContext,
	Boolean(referenceImage),
);
const storyId = story.id ?? basename(dirname(storyPath));
const outputDir = join(
	"story-images",
	"openai-comparisons",
	storyId,
	`section_${sectionNumber}`,
);
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "prompt.txt"), `${prompt}\n`, "utf8");

const results: Array<{
	bytes: number;
	file: string;
	latencyMs: number;
	model: (typeof MODELS)[number];
	usage?: unknown;
}> = [];

for (const model of MODELS) {
	const started = performance.now();
	const response = referenceImage
		? await editImage({ apiKey, model, prompt, referenceImage })
		: await generateImage({ apiKey, model, prompt });
	if (!response.ok) {
		throw new Error(
			`OpenAI image request failed for ${model}: ${response.status} ${response.statusText}\n${await response.text()}`,
		);
	}

	const json = (await response.json()) as ImageResponse;
	const encoded = json.data?.[0]?.b64_json;
	if (!encoded) {
		throw new Error(`OpenAI image response for ${model} had no image data.`);
	}
	const image = Buffer.from(encoded, "base64");
	const file = `${model}.webp`;
	await writeFile(join(outputDir, file), image);
	const result = {
		bytes: image.length,
		file,
		latencyMs: Math.round(performance.now() - started),
		model,
		usage: json.usage,
	};
	results.push(result);
	console.log(
		`${model}: ${result.latencyMs}ms, ${result.bytes} bytes -> ${join(outputDir, file)}`,
	);
}

await writeFile(
	join(outputDir, "manifest.json"),
	`${JSON.stringify(
		{
			generatedAt: new Date().toISOString(),
			prompt,
			request: {
				n: 1,
				outputFormat: "webp",
				quality: "low",
				reference: referencePath,
				size: "1536x1024",
			},
			results,
			section: sectionNumber,
			source: storyPath,
		},
		null,
		2,
	)}\n`,
	"utf8",
);
await writeFile(join(outputDir, "index.html"), comparisonPage(results), "utf8");
console.log(`Comparison page: ${join(outputDir, "index.html")}`);

async function generateImage({
	apiKey,
	model,
	prompt,
}: {
	apiKey: string;
	model: (typeof MODELS)[number];
	prompt: string;
}) {
	return fetch("https://api.openai.com/v1/images/generations", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			n: 1,
			output_format: "webp",
			prompt,
			quality: "low",
			size: "1536x1024",
		}),
	});
}

async function editImage({
	apiKey,
	model,
	prompt,
	referenceImage,
}: {
	apiKey: string;
	model: (typeof MODELS)[number];
	prompt: string;
	referenceImage: Buffer;
}) {
	const body = new FormData();
	body.append("model", model);
	body.append("n", "1");
	body.append("output_format", "webp");
	body.append("prompt", prompt);
	body.append("quality", "low");
	body.append("size", "1536x1024");
	body.append(
		"image[]",
		new Blob([Uint8Array.from(referenceImage)], { type: "image/webp" }),
		"reference.webp",
	);
	return fetch("https://api.openai.com/v1/images/edits", {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body,
	});
}

function comparisonPage(comparisons: typeof results): string {
	const cards = comparisons
		.map(
			(result) => `<figure>
	<img src="${result.file}" alt="Output from ${result.model}">
	<figcaption><strong>${result.model}</strong><br>${result.latencyMs} ms · ${formatBytes(result.bytes)}</figcaption>
</figure>`,
		)
		.join("\n");
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenAI image model comparison</title>
<style>
	body { margin: 24px; background: #171717; color: #eee; font: 16px/1.45 system-ui, sans-serif; }
	main { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }
	figure { margin: 0; padding: 12px; border-radius: 12px; background: #252525; }
	img { display: block; width: 100%; height: auto; border-radius: 8px; }
	figcaption { padding-top: 10px; }
</style>
<h1>OpenAI image model comparison</h1>
<p>Same prompt, size, quality, and format for every model. See <a href="prompt.txt">prompt.txt</a> and <a href="manifest.json">manifest.json</a>.</p>
<main>${cards}</main>
</html>
`;
}

function formatBytes(bytes: number): string {
	return `${(bytes / 1024).toFixed(0)} KiB`;
}

function parseSectionNumber(value: string): number {
	const sectionNumber = Number.parseInt(value, 10);
	if (!Number.isInteger(sectionNumber) || sectionNumber < 1) {
		throw new Error("Section number must be a positive integer.");
	}
	return sectionNumber;
}
