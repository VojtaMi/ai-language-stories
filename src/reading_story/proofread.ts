import type { Language } from "../languages";
import { parseJsonResponse } from "../learnerState";
import type { TextModelId } from "../models";
import type { ChatMessage, Complete } from "../story";
import { isObject } from "../structuredGeneration";
import type { ReadingStoryManuscript } from "./manuscript";

const PROOFREAD_MAX_TOKENS = 4000;

/**
 * Proofreading is a narrow correctness check, deliberately independent of the
 * user-selected prose model: a cheaper prose preset must not lower the
 * grammatical floor of what a beginner reads. On seeded case, agreement, and
 * vocative errors (three runs each), GPT 6 Sol at medium caught 21/21 at ~5s;
 * GPT 6 Luna caught 19/21 at medium and 20/21 at high (~25s). None edited a
 * grammatical control text.
 */
export const READING_STORY_PROOFREAD_MODEL: TextModelId = "gpt-6-sol";

export interface ManuscriptCorrection {
	original: string;
	corrected: string;
}

function proofreadPrompt(genre: Language) {
	return `You are a meticulous native-level ${genre.label} proofreader for a beginner reading app.

Find every grammatical error in the ${genre.label} story text: wrong endings, case, gender or number agreement, verb forms, articles, prepositions governing the wrong case, wrongly inflected names, and misused function words. ${genre.grammarInvariants}

Do not change style, vocabulary choice, difficulty, punctuation conventions, or meaning. Never change which character a pronoun refers to or a character's gender; the story may introduce people you cannot see in a sentence. Do not report anything that is grammatical, even if you would phrase it differently.

For each error, copy the complete original sentence exactly as it appears in the text, and give the minimally corrected sentence.

Return only JSON: {"corrections":[{"original":"exact sentence from the text","corrected":"corrected sentence","reason":"short English reason"}]}. Return {"corrections":[]} when the text has no grammatical errors.`;
}

export function readingProofreadMessages(
	manuscript: ReadingStoryManuscript,
	genre: Language,
): ChatMessage[] {
	return [
		{ role: "system", content: proofreadPrompt(genre) },
		{ role: "user", content: JSON.stringify({ text: manuscript.text }) },
	];
}

export function parseManuscriptCorrections(
	raw: string,
): ManuscriptCorrection[] {
	const value = parseJsonResponse(raw);
	if (!isObject(value) || !Array.isArray(value.corrections)) {
		throw new Error("Proofreading JSON is missing corrections.");
	}
	return value.corrections.flatMap((item) =>
		isObject(item) &&
		typeof item.original === "string" &&
		typeof item.corrected === "string"
			? [{ original: item.original, corrected: item.corrected }]
			: [],
	);
}

/**
 * Applies only corrections that are unambiguous, local substitutions: the
 * original occurs exactly once, and the replacement is a comparable sentence
 * rather than a rewrite. Anything else is dropped, so a confused proofreader
 * can at worst leave an error in place, never damage the prose around it.
 */
export function applyManuscriptCorrections(
	text: string,
	corrections: ManuscriptCorrection[],
): { text: string; applied: ManuscriptCorrection[] } {
	let next = text;
	const applied: ManuscriptCorrection[] = [];
	for (const { original, corrected } of corrections) {
		const from = original.trim();
		const to = corrected.trim();
		if (!from || !to || from === to) continue;
		if (to.length > from.length * 1.5 + 10 || to.length < from.length * 0.5) {
			continue;
		}
		const first = next.indexOf(from);
		if (first === -1 || next.indexOf(from, first + 1) !== -1) continue;
		next = next.slice(0, first) + to + next.slice(first + from.length);
		applied.push({ original: from, corrected: to });
	}
	return { text: next, applied };
}

/**
 * Corrects grammatical slips in a finished manuscript before it is divided.
 * Proofreading improves an already valid story, so a failed call keeps the
 * manuscript as written rather than failing preparation.
 */
export async function proofreadReadingManuscript(
	complete: Complete,
	manuscript: ReadingStoryManuscript,
	genre: Language,
): Promise<ReadingStoryManuscript> {
	let corrections: ManuscriptCorrection[];
	try {
		corrections = parseManuscriptCorrections(
			await complete(
				readingProofreadMessages(manuscript, genre),
				PROOFREAD_MAX_TOKENS,
				{ model: READING_STORY_PROOFREAD_MODEL, reasoningEffort: "medium" },
			),
		);
	} catch (error) {
		console.warn("Could not proofread the reading story manuscript.", error);
		return manuscript;
	}
	const { text } = applyManuscriptCorrections(manuscript.text, corrections);
	return { ...manuscript, text };
}
