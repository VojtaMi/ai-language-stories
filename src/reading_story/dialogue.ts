import type { Language } from "../languages";
import { isObject } from "../structuredGeneration";

/** Coarse voice categories; code maps each to concrete TTS voices. */
export const CHARACTER_VOICE_TYPES = [
	"woman",
	"man",
	"girl",
	"boy",
	"older woman",
	"older man",
] as const;
export type CharacterVoiceType = (typeof CHARACTER_VOICE_TYPES)[number];

/** A character who speaks at least one quoted line. The narrator is never one. */
export interface StoryCharacter {
	name: string;
	voiceType: CharacterVoiceType;
}

/**
 * Who says one quotation and how. `dialogue[n]` voices the n-th quotation of
 * the whole story, so attribution survives splitting without offsets.
 */
export interface DialogueLine {
	speaker: string;
	/** Short English acting note for the speech model, e.g. "soft, hopeful". */
	delivery: string;
}

export type DialogueQuotes = Language["dialogueQuotes"];

/** One quotation including its marks: `text.slice(start, end)`. */
export interface Quotation {
	start: number;
	end: number;
}

export interface DialogueSegment {
	text: string;
	/** Index into the story's `dialogue` for a quotation; absent for narration. */
	dialogueIndex?: number;
}

/**
 * Locates every quotation delimited by the language's dialogue marks. Marks
 * that cannot pair up are an error rather than a guess, because attribution is
 * positional and one stray mark would shift every later speaker.
 */
export function findQuotations(
	text: string,
	{ open, close }: DialogueQuotes,
): Quotation[] {
	const quotations: Quotation[] = [];
	let start = -1;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (start >= 0) {
			if (character === close) {
				quotations.push({ start, end: index + 1 });
				start = -1;
			} else if (character === open) {
				throw new Error(`A quotation opens inside another quotation.`);
			}
		} else if (character === open) {
			start = index;
		} else if (character === close) {
			throw new Error(`A closing ${close} has no opening ${open}.`);
		}
	}
	if (start >= 0) throw new Error(`An opening ${open} is never closed.`);
	return quotations;
}

/**
 * Splits text into alternating narration and quotation segments, numbering
 * quotations from `firstDialogueIndex` so a later part continues the story's
 * count.
 */
export function dialogueSegments(
	text: string,
	quotes: DialogueQuotes,
	firstDialogueIndex = 0,
): DialogueSegment[] {
	const segments: DialogueSegment[] = [];
	let cursor = 0;
	findQuotations(text, quotes).forEach(({ start, end }, index) => {
		if (start > cursor) segments.push({ text: text.slice(cursor, start) });
		segments.push({
			text: text.slice(start, end),
			dialogueIndex: firstDialogueIndex + index,
		});
		cursor = end;
	});
	if (cursor < text.length) segments.push({ text: text.slice(cursor) });
	return segments;
}

/**
 * Validates the author's attribution against the quotations actually present
 * in the prose. Characters who never speak are dropped rather than rejected.
 */
export function parseDialogueAttribution(
	text: string,
	quotes: DialogueQuotes,
	rawCharacters: unknown,
	rawDialogue: unknown,
): { characters: StoryCharacter[]; dialogue: DialogueLine[] } {
	if (!Array.isArray(rawCharacters) || !Array.isArray(rawDialogue)) {
		throw new Error("The manuscript needs characters and dialogue arrays.");
	}
	const characters = rawCharacters.map((item): StoryCharacter => {
		if (
			!isObject(item) ||
			typeof item.name !== "string" ||
			!item.name.trim() ||
			!CHARACTER_VOICE_TYPES.includes(item.voiceType as CharacterVoiceType)
		) {
			throw new Error(
				`Every character needs a name and a voiceType from: ${CHARACTER_VOICE_TYPES.join(", ")}.`,
			);
		}
		return {
			name: item.name.trim(),
			voiceType: item.voiceType as CharacterVoiceType,
		};
	});
	const names = new Set(characters.map((character) => character.name));
	if (names.size !== characters.length) {
		throw new Error("Character names must be unique.");
	}
	const dialogue = rawDialogue.map((item): DialogueLine => {
		if (
			!isObject(item) ||
			typeof item.speaker !== "string" ||
			!names.has(item.speaker.trim()) ||
			typeof item.delivery !== "string" ||
			!item.delivery.trim()
		) {
			throw new Error(
				"Every dialogue entry needs a speaker listed in characters and a delivery note.",
			);
		}
		return { speaker: item.speaker.trim(), delivery: item.delivery.trim() };
	});
	const quotationCount = findQuotations(text, quotes).length;
	if (quotationCount !== dialogue.length) {
		throw new Error(
			`The text has ${quotationCount} ${quotes.open}…${quotes.close} quotations but dialogue has ${dialogue.length} entries.`,
		);
	}
	const speakers = new Set(dialogue.map((line) => line.speaker));
	return {
		characters: characters.filter((character) => speakers.has(character.name)),
		dialogue,
	};
}

/** The attribution one section's narration needs: its own lines, in order. */
export interface SectionDialogue {
	characters: StoryCharacter[];
	lines: DialogueLine[];
}

/**
 * Picks the dialogue lines that belong to one section (1-based `partIndex`) by
 * counting the quotations in the parts before it. Returns undefined when the
 * section has no attributed speech, so it is narrated in one voice.
 */
export function readingSectionDialogue(
	parts: { text: string }[],
	characters: StoryCharacter[] | undefined,
	dialogue: DialogueLine[] | undefined,
	partIndex: number,
	quotes: DialogueQuotes,
): SectionDialogue | undefined {
	const part = parts[partIndex - 1];
	if (!part || !characters?.length || !dialogue?.length) return undefined;
	const first = parts
		.slice(0, partIndex - 1)
		.reduce(
			(count, { text }) => count + findQuotations(text, quotes).length,
			0,
		);
	const lines = dialogue.slice(
		first,
		first + findQuotations(part.text, quotes).length,
	);
	if (!lines.length) return undefined;
	const speakers = new Set(lines.map((line) => line.speaker));
	return {
		characters: characters.filter((character) => speakers.has(character.name)),
		lines,
	};
}
