import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import OpenAI from "openai";
import { languages } from "../src/languages.ts";
import {
	type GeminiImageModel,
	generateStoryImage,
} from "../src/server/images/index.ts";
import type { ReadingStory } from "../src/story.ts";

type StoryRecord = {
	genreId?: string;
	id?: string;
	readingStory?: Pick<ReadingStory, "visualContext">;
	segments?: Array<{
		text?: string;
	}>;
};

const storyPath = process.argv[2];
if (!storyPath) {
	throw new Error(
		"Usage: compare-gemini-images.ts <browser-story-json> [sections] [model]",
	);
}
const sectionNumbers = (process.argv[3] ?? "1,5")
	.split(",")
	.map((value) => Number.parseInt(value.trim(), 10))
	.filter((value) => Number.isInteger(value) && value > 0);
const geminiModel = geminiImageModel(process.argv[4] ?? "flash");

if (sectionNumbers.length === 0) {
	console.error("Error: provide at least one section number, such as 1,5.");
	process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
	console.error("Error: GEMINI_API_KEY is required in .env.local.");
	process.exit(1);
}

const story = JSON.parse(await readFile(storyPath, "utf8")) as StoryRecord;
const genre = languages.find((candidate) => candidate.id === story.genreId);
if (!genre) {
	console.error(`Error: unknown genreId in ${storyPath}.`);
	process.exit(1);
}

const storyId = story.id ?? basename(dirname(storyPath));
const outputDir = join("story-images", "gemini-comparisons", storyId);
await mkdir(outputDir, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });
const manifest = {
	source: storyPath,
	generatedAt: new Date().toISOString(),
	geminiModel,
	sections: [] as Array<{
		file: string;
		model: string;
		openAiReference: string;
		provider: string;
		section: number;
	}>,
};

for (const sectionNumber of sectionNumbers) {
	const storyText = story.segments?.[sectionNumber - 1]?.text?.trim();
	if (!storyText) {
		console.warn(`Skipping section ${sectionNumber}: no story text.`);
		continue;
	}

	const image = await generateStoryImage({
		geminiModel,
		genre,
		openai,
		provider: "gemini",
		storyText,
		visualContext: readingVisualContext(story),
	});
	const filename = `section_${sectionNumber}_${modelSlug(image.model)}.${image.extension}`;
	const file = join(outputDir, filename);
	await writeFile(file, image.image);
	await writeFile(
		join(
			outputDir,
			`section_${sectionNumber}_${modelSlug(image.model)}_prompt.txt`,
		),
		image.prompt,
		"utf8",
	);
	manifest.sections.push({
		file,
		model: image.model,
		openAiReference: join(
			"stories",
			genre.id,
			storyId,
			"images",
			`section_${sectionNumber}.webp`,
		),
		provider: image.provider,
		section: sectionNumber,
	});
	console.log(
		`Generated Gemini comparison for section ${sectionNumber}: ${file}`,
	);
}

await writeFile(
	join(outputDir, "manifest.json"),
	`${JSON.stringify(manifest, null, 2)}\n`,
	"utf8",
);

function readingVisualContext(story: StoryRecord) {
	const readingStory = story.readingStory;
	if (!readingStory) return undefined;
	return readingStory.visualContext;
}

function geminiImageModel(value: string): GeminiImageModel {
	if (
		value === "lite" ||
		value === "flash-lite" ||
		value === "gemini-3.1-flash-lite-image"
	) {
		return "gemini-3.1-flash-lite-image";
	}
	if (value === "flash" || value === "gemini-3.1-flash-image") {
		return "gemini-3.1-flash-image";
	}

	console.error(
		"Error: Gemini image model must be flash, lite, gemini-3.1-flash-image, or gemini-3.1-flash-lite-image.",
	);
	process.exit(1);
}

function modelSlug(model: string) {
	return model === "gemini-3.1-flash-lite-image" ? "gemini_lite" : "gemini";
}
