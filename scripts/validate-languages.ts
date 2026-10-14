import { access } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
	getLanguage,
	isLanguageId,
	languageBotImageUrl,
	languageFaviconUrl,
	languageHeroImageUrl,
	languageSelectionLabel,
	languages,
} from "../src/languages.ts";
import {
	bundleIdPattern,
	createBundleId,
	storyLanguage,
} from "../src/server/storyBundleStore.ts";

const requestedIds = process.argv
	.slice(2)
	.filter((argument) => argument !== "--");
const errors: string[] = [];
const publicDir = resolve(process.cwd(), "public");

if (requestedIds.includes("--help")) {
	process.stdout.write(`Usage: npm run language:validate -- [language-id ...]

Validate every registered language, or only the named languages. This checks
registry fields, uniqueness, public assets, and language-specific story IDs.
It does not call an AI provider or assess the quality of language guidance.
`);
	process.exit(0);
}

const selectedLanguages = requestedIds.length
	? requestedIds.flatMap((id) => {
			if (!isLanguageId(id)) {
				errors.push(`Language "${id}" is not registered in src/languages.ts.`);
				return [];
			}
			return [getLanguage(id)];
		})
	: languages;

for (const field of ["id", "shortCode"] as const) {
	const duplicates = duplicateValues(
		languages.map((language) => language[field]),
	);
	for (const value of duplicates) {
		errors.push(`${field} must be unique; "${value}" is used more than once.`);
	}
}

for (const value of duplicateValues(languages.map(languageSelectionLabel))) {
	errors.push(
		`Language selection labels must be unique; "${value}" is used more than once.`,
	);
}

for (const language of selectedLanguages) {
	const prefix = `[${language.id}]`;
	if (!/^[a-z][a-z0-9-]*$/.test(language.id)) {
		errors.push(`${prefix} id must be a lowercase ASCII slug.`);
	}
	if (!/^[A-Z]{2,4}$/.test(language.shortCode)) {
		errors.push(
			`${prefix} shortCode must contain 2–4 uppercase ASCII letters.`,
		);
	}

	try {
		if (Intl.getCanonicalLocales(language.locale)[0] !== language.locale) {
			errors.push(`${prefix} locale must be a canonical BCP 47 tag.`);
		}
	} catch {
		errors.push(`${prefix} locale is not a valid BCP 47 tag.`);
	}

	for (const field of [
		"label",
		"teachingTopics",
		"absoluteBeginnerGuidance",
		"grammarInvariants",
		"starterFocus",
		"recapTitle",
	] as const) {
		if (!language[field].trim()) errors.push(`${prefix} ${field} is empty.`);
	}

	if (!language.calibrationSnippets.length) {
		errors.push(`${prefix} calibrationSnippets needs at least one example.`);
	}
	for (const snippet of language.calibrationSnippets) {
		if (!snippet.trim())
			errors.push(`${prefix} has an empty calibration snippet.`);
	}

	await validateAsset(
		language.id,
		"hero image",
		languageHeroImageUrl(language),
	);
	await validateAsset(language.id, "bot image", languageBotImageUrl(language));
	await validateAsset(language.id, "favicon", languageFaviconUrl(language));

	const bundleId = createBundleId(language.id, "Validation story", "ABCDEF12");
	if (!bundleIdPattern.test(bundleId)) {
		errors.push(`${prefix} generated story id is rejected: ${bundleId}`);
	} else if (storyLanguage(bundleId) !== language.id) {
		errors.push(`${prefix} generated story id resolves to the wrong language.`);
	}
}

if (errors.length) {
	process.stderr.write(
		`Language validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`,
	);
	process.exitCode = 1;
} else {
	process.stdout.write(
		`Validated ${selectedLanguages.length} language${selectedLanguages.length === 1 ? "" : "s"}: ${selectedLanguages.map(({ id }) => id).join(", ")}\n`,
	);
}

async function validateAsset(
	languageId: string,
	field: "hero image" | "bot image" | "favicon",
	url: string,
) {
	const pathname = url.split("?", 1)[0];
	if (!pathname.startsWith("/")) {
		errors.push(`[${languageId}] ${field} must be a root-relative public URL.`);
		return;
	}
	const path = resolve(publicDir, pathname.slice(1));
	if (!path.startsWith(`${publicDir}${sep}`)) {
		errors.push(`[${languageId}] ${field} escapes the public directory.`);
		return;
	}
	try {
		await access(path);
	} catch {
		errors.push(`[${languageId}] ${field} does not exist: ${pathname}`);
	}
}

function duplicateValues(values: string[]): string[] {
	return [
		...new Set(
			values.filter((value, index) => values.indexOf(value) !== index),
		),
	];
}
