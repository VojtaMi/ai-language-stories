import { readdir, stat } from "node:fs/promises";
import { join, parse } from "node:path";
import sharp from "sharp";

const sourceDirectory = join(process.cwd(), "assets", "language-images");
const imageDirectory = join(process.cwd(), "public", "images");
const sourcePattern = /-(story-hero|story-bot)\.png$/;
// The bot is shown at most ~150 CSS px, so 512 stays sharp on 3x screens.
const BOT_SIZE = 512;
const BOT_QUALITY = 88;
// The poster is a full-page background; it keeps its source size, and below
// 65 the painted texture starts to smear.
const HERO_QUALITY = 65;
const files = (await readdir(sourceDirectory))
	.filter((file) => sourcePattern.test(file))
	.sort();

if (files.length === 0) {
	throw new Error(`No language PNG assets found in ${sourceDirectory}.`);
}

for (const file of files) {
	const inputPath = join(sourceDirectory, file);
	const parsed = parse(file);
	const isBot = parsed.name.endsWith("-story-bot");
	const outputPath = join(imageDirectory, `${parsed.name}.avif`);
	const source = sharp(inputPath);
	const resized = isBot
		? source.resize(BOT_SIZE, BOT_SIZE, { fit: "inside" })
		: source;

	const output = await resized
		.avif({
			quality: isBot ? BOT_QUALITY : HERO_QUALITY,
			effort: 4,
		})
		.toFile(outputPath);

	const outputSize = (await stat(outputPath)).size;
	console.log(
		`${file} → ${parsed.name}.avif ` +
			`(${output.width}×${output.height}, ` +
			`${Math.round(outputSize / 1024)} KiB)`,
	);
}

console.log(
	`Optimized ${files.length} language image${files.length === 1 ? "" : "s"}.`,
);
