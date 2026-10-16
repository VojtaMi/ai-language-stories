import { DEFAULT_LANGUAGE, type Language } from "../languages";
import { parseJsonResponse } from "../learnerState";
import { DEFAULT_TEXT_MODEL } from "../models";
import type { ChatMessage, Complete, ReadingStoryPart } from "../story";
import { countWords } from "../structuredGeneration";
import { type DialogueQuotes, findQuotations } from "./dialogue";
import type { ReadingStoryManuscript } from "./manuscript";

const SPLIT_MAX_TOKENS = 600;
export const READING_STORY_MAX_PARTS = 8;

function splitPrompt(genre: Language) {
	return `Divide an already finished ${genre.label} reading story into presentation parts.

The numbered sentences are immutable. Return only sentence numbers after which the app should break the story. Do not include the final sentence number, because the story ends there. Do not return prose and do not rewrite, omit, duplicate, or reorder anything.

Choose the number of parts that best fits the manuscript, within allowedPartCount. Split the story into similarly sized parts. Each part should cover one coherent story event or beat, such as the setup, a problem, an attempt, a discovery, or a result. An event may contain several directly connected actions and their immediate consequence. End a part when that event is complete or the story's focus changes. Do not isolate a transition or one short sentence as its own part. Do not split an action from its immediate result merely to equalize size.

Return only valid JSON matching exactly:
{"breakAfterSentence":[2,5]}`;
}

type SplitRange = {
	min: number;
	max: number;
};

/**
 * Splits prose into sentences without ever ending one inside a dialogue
 * quotation, so section boundaries cannot separate a line from its speaker
 * mark. A quotation ending in .!? closes a sentence unless the narration
 * continues in lowercase after it.
 */
export function readingStorySentences(
	text: string,
	quotes?: DialogueQuotes,
): string[] {
	const quotations = quotes ? findQuotations(text, quotes) : [];
	const sentences: string[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		const quotation = quotations.find(
			(candidate) => candidate.start <= index && index < candidate.end,
		);
		let end: number;
		if (quotation) {
			if (index !== quotation.end - 1 || !".!?".includes(text[index - 1])) {
				continue;
			}
			end = index + 1;
			if (/^\s*\p{Ll}/u.test(text.slice(end))) continue;
		} else {
			if (!".!?".includes(text[index])) continue;
			end = index + 1;
			while (end < text.length && /[”"'’»›]/u.test(text[end])) end += 1;
		}
		if (end < text.length && !/\s/u.test(text[end])) continue;
		while (end < text.length && /\s/u.test(text[end])) end += 1;
		sentences.push(text.slice(start, end));
		start = end;
		index = end - 1;
	}
	if (start < text.length) sentences.push(text.slice(start));
	const nonEmptySentences = sentences.filter((sentence) => sentence.trim());
	if (nonEmptySentences.join("") !== text) {
		throw new Error(
			"Could not preserve the complete manuscript while segmenting it.",
		);
	}
	return nonEmptySentences;
}

function allowedSplitRange(sentenceCount: number): SplitRange {
	return {
		min: 2,
		max: Math.min(READING_STORY_MAX_PARTS, sentenceCount),
	};
}

export function readingStorySplitMessages(
	manuscript: ReadingStoryManuscript,
	genre: Language = DEFAULT_LANGUAGE,
): ChatMessage[] {
	const sentences = readingStorySentences(
		manuscript.text,
		genre.dialogueQuotes,
	);
	const range = allowedSplitRange(sentences.length);
	return [
		{ role: "system", content: splitPrompt(genre) },
		{
			role: "user",
			content: JSON.stringify({
				allowedPartCount: { min: range.min, max: range.max },
				sentences: sentences.map((sentence, index) => ({
					number: index + 1,
					wordCount: countWords(sentence),
					text: sentence.trim(),
				})),
			}),
		},
	];
}

export async function splitReadingManuscript(
	complete: Complete,
	manuscript: ReadingStoryManuscript,
	genre: Language = DEFAULT_LANGUAGE,
): Promise<ReadingStoryPart[]> {
	const sentences = readingStorySentences(
		manuscript.text,
		genre.dialogueQuotes,
	);
	if (sentences.length < 2) {
		throw new Error(
			"The finished reading story has too few sentences to split.",
		);
	}
	const range = allowedSplitRange(sentences.length);
	const messages = readingStorySplitMessages(manuscript, genre);
	const raw = await complete(messages, SPLIT_MAX_TOKENS, {
		model: DEFAULT_TEXT_MODEL,
	});
	let breaks: number[];
	try {
		breaks = parseBreaks(raw, sentences.length, range);
	} catch {
		const retry = await complete(
			[
				...messages,
				{ role: "assistant", content: raw },
				{
					role: "user",
					content: `That response has invalid boundaries. Return strictly increasing sentence numbers from 1 through ${sentences.length - 1}, producing ${range.min}-${range.max} non-empty parts. Do not include the final sentence number. Choose coherent event-based boundaries again.`,
				},
			],
			SPLIT_MAX_TOKENS,
			{ model: DEFAULT_TEXT_MODEL },
		);
		breaks = parseBreaks(retry, sentences.length, range);
	}
	return assembleParts(sentences, breaks, manuscript.text);
}

function parseBreaks(
	raw: string,
	sentenceCount: number,
	range: SplitRange,
): number[] {
	const value = parseJsonResponse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("The AI returned an invalid reading story split.");
	}
	const breaks = (value as { breakAfterSentence?: unknown }).breakAfterSentence;
	if (
		!Array.isArray(breaks) ||
		breaks.some(
			(item) =>
				!Number.isInteger(item) ||
				(item as number) < 1 ||
				(item as number) > sentenceCount,
		)
	) {
		throw new Error("The AI returned invalid reading story boundaries.");
	}
	const numbers = [...(breaks as number[])];
	if (numbers[numbers.length - 1] === sentenceCount) numbers.pop();
	if (
		numbers.some(
			(item, index) =>
				item >= sentenceCount || (index > 0 && item <= numbers[index - 1]),
		) ||
		numbers.length + 1 < range.min ||
		numbers.length + 1 > range.max
	) {
		throw new Error("The AI returned invalid reading story boundaries.");
	}
	return numbers;
}

function assembleParts(
	sentences: string[],
	breaks: number[],
	original: string,
): ReadingStoryPart[] {
	const parts: ReadingStoryPart[] = [];
	let start = 0;
	for (const end of [...breaks, sentences.length]) {
		parts.push({ text: sentences.slice(start, end).join("").trim() });
		start = end;
	}
	const reconstructed = parts.map((part) => part.text).join(" ");
	const normalizedOriginal = original.trim().replace(/\s+/g, " ");
	if (reconstructed.replace(/\s+/g, " ") !== normalizedOriginal) {
		throw new Error("Reading story splitting changed the finished manuscript.");
	}
	return parts;
}
