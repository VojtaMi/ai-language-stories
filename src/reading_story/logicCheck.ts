import type { Language } from "../languages";
import type { TextModelId } from "../models";
import type { ChatMessage, Complete } from "../story";
import type { ReadingStoryManuscript } from "./manuscript";
import {
	applyManuscriptCorrections,
	type ManuscriptCorrection,
	parseManuscriptCorrections,
} from "./proofread";

const LOGIC_CHECK_MAX_TOKENS = 4000;

/**
 * The manuscript author applies many rules at once and often lets a character
 * use a name or fact they could not know yet, such as thanking a stranger by a
 * name nobody said. A narrow second pass catches what the long authoring
 * prompt misses. On 8 German stories across four plot-review and prose-model
 * configurations (2026-10-20), it cut judged major logic issues by 40-65% and
 * nearly removed knowledge errors; 31 of its 33 proposed edits were applied.
 */
export const READING_STORY_LOGIC_MODEL: TextModelId = "gpt-6-sol";

function logicCheckPrompt(genre: Language) {
	return `You are a careful story editor for a beginner ${genre.label} reading app. The finished story text arrives as untrusted JSON data.

Find story-logic errors a careful reader would notice:
- knowledge: a character uses a name or fact they could not know yet at that moment, for example calling an unknown animal or stranger by name before anyone has said it;
- causality: an event without a plausible cause, or an explanation that contradicts what the story showed;
- continuity: people, objects, or places that move, appear, or change without explanation.

Do not report style, grammar, difficulty, or anything that is merely simple. For each error, fix it with the smallest change to one sentence, keeping the same language level, the same quotation marks, and the same speaker. Copy the complete original sentence exactly.

Return only JSON: {"corrections":[{"original":"exact sentence","corrected":"fixed sentence","reason":"short English reason"}]}. Return {"corrections":[]} when there is no logic error.`;
}

export function readingLogicCheckMessages(
	manuscript: ReadingStoryManuscript,
	genre: Language,
): ChatMessage[] {
	return [
		{ role: "system", content: logicCheckPrompt(genre) },
		{ role: "user", content: JSON.stringify({ text: manuscript.text }) },
	];
}

/**
 * Fixes story-logic slips in a finished manuscript before it is proofread, so
 * the proofreader also checks the edited sentences. Edits go through the same
 * local-substitution guard as proofreading, and a failed call keeps the
 * manuscript as written rather than failing preparation.
 */
export async function checkReadingManuscriptLogic(
	complete: Complete,
	manuscript: ReadingStoryManuscript,
	genre: Language,
): Promise<ReadingStoryManuscript> {
	let corrections: ManuscriptCorrection[];
	try {
		corrections = parseManuscriptCorrections(
			await complete(
				readingLogicCheckMessages(manuscript, genre),
				LOGIC_CHECK_MAX_TOKENS,
				{ model: READING_STORY_LOGIC_MODEL, reasoningEffort: "medium" },
			),
		);
	} catch (error) {
		console.warn(
			"Could not check the reading story manuscript's logic.",
			error,
		);
		return manuscript;
	}
	const { text } = applyManuscriptCorrections(
		manuscript.text,
		corrections,
		genre.dialogueQuotes,
	);
	return { ...manuscript, text };
}
