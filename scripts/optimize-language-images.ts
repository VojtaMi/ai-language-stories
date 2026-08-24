import { readdir, stat } from "node:fs/promises";
import { join, parse } from "node:path";
import sharp from "sharp";

const sourceDirectory = join(process.cwd(), "assets", "language-images");
const imageDirectory = join(process.cwd(), "public", "images");
const sourcePattern = /-(story-hero|story-bot)\.png$/;
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
	const metadata = await source.metadata();

	await source
		.avif({
			quality: isBot ? 88 : 82,
			effort: 4,
		})
		.toFile(outputPath);

	const outputSize = (await stat(outputPath)).size;
	console.log(
		`${file} → ${parsed.name}.avif ` +
			`(${metadata.width ?? "?"}×${metadata.height ?? "?"}, ` +
			`${Math.round(outputSize / 1024)} KiB)`,
	);
}

console.log(
	`Optimized ${files.length} language image${files.length === 1 ? "" : "s"}.`,
);
