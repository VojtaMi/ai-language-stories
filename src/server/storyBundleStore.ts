import { access } from "node:fs/promises";
import { join } from "node:path";
import { isLanguageId, type LanguageId, languages } from "../languages";

export const storiesDir = join(process.cwd(), "stories");

/** Safe path segment accepted for current and legacy story identifiers. */
export const storyIdPattern = /^[a-zA-Z0-9_-]+$/;

const languageIdAlternatives = languages.map(({ id }) => id).join("|");
export const bundleIdPattern = new RegExp(
	`^(?:${languageIdAlternatives})--[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+$`,
);

export function createBundleId(genreId: LanguageId, label: string, id: string) {
	const slug = slugify(label) || "story";
	return `${genreId}--${slug}--${id.slice(0, 8).toLowerCase()}`;
}

export function slugify(value: string) {
	return value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

export function storyBundlePath(storyId: string) {
	return join(storiesDir, storyLanguage(storyId), storyId);
}

export function storyLanguage(storyId: string): LanguageId {
	const language = storyId.split("--", 1)[0];
	if (!isLanguageId(language)) {
		throw new Error(`Story id does not contain a valid language: ${storyId}`);
	}
	return language;
}

export function bundledFinishEvidencePath(storyId: string) {
	return join(storyBundlePath(storyId), "finish-evidence.json");
}

export function bundledAudioPath(storyId: string, filename: string) {
	return join(storyBundlePath(storyId), "audio", filename);
}

export function bundledImagesPath(storyId: string, filename: string) {
	return join(storyBundlePath(storyId), "images", filename);
}

export async function pathExists(path: string) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
