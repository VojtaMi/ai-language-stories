/**
 * Experiment: how should later reading-story images be anchored to earlier ones?
 *
 * Baseline  = stories/<id>/images/section_{3,5}.webp                (prompt only)
 * Round 1   = stories/<id>/alternative-images/section_{3,5}.webp    (prompt + full-size section 1)
 * Round 2   = stories/<id>/alternative-images-v2/*.webp             (this script)
 *
 * Round 2 varies two things against round 1:
 *   - the reference is downscaled to 768x512 before sending (input-token cost)
 *   - the instruction gives the scene description authority over new objects
 * and adds a chained variant that also attaches the previous section's image.
 *
 * Usage: npx tsx --env-file-if-exists=.env.local scripts/reference-image-experiment.ts <browser-story-json>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import OpenAI, { toFile } from "openai";
import type { Language } from "../src/languages.ts";
import { buildStoryBackgroundPrompt } from "../src/server/images/prompts.ts";
import { type ReadingStory, readingVisualContext } from "../src/story.ts";

/**
 * Tells the model what the attachments are for. The second sentence is the
 * round-2 change: round 1 lost a plot-critical object (the silver disk) because
 * the reference, which does not contain it yet, outvoted the description.
 */
const REFERENCE_INSTRUCTION =
	"The attached images are earlier scenes of this same story, provided only to fix identity: keep the same faces, hair, clothing, creature design, and art style. " +
	"The scene description above has final authority over what happens and what is present: render every object it names, exactly as described, even when that object is absent from or looks different in the attached images.";

const storyPath = process.argv[2];
if (!storyPath) {
	throw new Error("Usage: reference-image-experiment.ts <browser-story-json>");
}
const story = JSON.parse(await readFile(storyPath, "utf8")) as {
	id: string;
	genreId: string;
	readingStory: ReadingStory;
};

const readingStory = story.readingStory;
const storyDir = join(process.cwd(), "stories", story.genreId, story.id);
const genre = { id: story.genreId, label: "Esperanto" } as unknown as Language;
const visualContext = readingVisualContext(readingStory);

const outDir = join(storyDir, "alternative-images-v2");
await mkdir(outDir, { recursive: true });

const refDir = join(storyDir, ".refs");
const reference = async (name: string) =>
	toFile(await readFile(join(refDir, name)), name, { type: "image/webp" });

const openai = new OpenAI();

/** imagePrompts[1] -> section 3, imagePrompts[2] -> section 5. */
const runs = [
	{ label: "section_3_small", promptIndex: 1, refs: ["section_1_small.webp"] },
	{ label: "section_5_small", promptIndex: 2, refs: ["section_1_small.webp"] },
	{
		label: "section_5_chained",
		promptIndex: 2,
		refs: ["section_1_small.webp", "section_3_small.webp"],
	},
] as const;

for (const run of runs) {
	const prompt = `${buildStoryBackgroundPrompt(
		genre,
		readingStory.imagePrompts[run.promptIndex],
		visualContext,
	)}\n${REFERENCE_INSTRUCTION}`;

	const response = await openai.images.edit({
		model: "gpt-image-2",
		image: await Promise.all(run.refs.map(reference)),
		prompt,
		size: "1536x1024",
		quality: "low",
		output_format: "webp",
		n: 1,
	});

	const encoded = response.data?.[0]?.b64_json;
	if (!encoded) throw new Error(`No image data for ${run.label}.`);
	await writeFile(
		join(outDir, `${run.label}.webp`),
		Buffer.from(encoded, "base64"),
	);
	console.log(
		`${run.label}: refs=${run.refs.length} usage=${JSON.stringify(response.usage)}`,
	);
}
