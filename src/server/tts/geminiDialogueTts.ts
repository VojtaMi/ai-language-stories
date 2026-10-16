import {
	type CharacterVoiceType,
	type DialogueQuotes,
	dialogueSegments,
	type SectionDialogue,
} from "../../reading_story/dialogue";
import type { NarrationSegment } from "../../storyAudio";
import { AiTraceError, traceAiCall } from "../aiTrace";
import type { GeminiTtsModel } from "./constants";
import type { SynthesizedSpeech } from "./types";
import { pcmToWav } from "./wav";

const SAMPLE_RATE = 24_000;
/** 16-bit mono PCM. */
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** Pause inserted where two separately synthesized requests meet. */
const REQUEST_GAP_MS = 300;
const MAX_ATTEMPTS = 3;
/** A rate-limit wait longer than this fails the section instead of stalling it. */
const MAX_RETRY_WAIT_MS = 20_000;

/**
 * Prebuilt Gemini voices per character type, best fit first. Several per type
 * so two characters of one type, and the narrator, never share a voice.
 */
const CHARACTER_VOICES: Record<CharacterVoiceType, string[]> = {
	woman: ["Kore", "Aoede", "Despina", "Erinome", "Callirrhoe"],
	man: ["Charon", "Orus", "Achird", "Umbriel", "Alnilam"],
	girl: ["Leda", "Laomedeia", "Autonoe", "Zephyr"],
	boy: ["Puck", "Fenrir", "Sadachbia"],
	"older woman": ["Gacrux", "Vindemiatrix", "Achernar", "Sulafat"],
	"older man": ["Algenib", "Sadaltager", "Rasalgethi", "Schedar"],
};

const VOICE_TYPE_STYLE: Record<CharacterVoiceType, string> = {
	woman: "an adult woman",
	man: "an adult man",
	girl: "a young girl",
	boy: "a young boy",
	"older woman": "an older woman",
	"older man": "an older man",
};

export interface SpeechTurn {
	/** Stable request-level speaker id; "Narrator" for narration. */
	speaker: string;
	voice: string;
	text: string;
	style: string;
	/** Where this turn's stretch of the section text begins. */
	textStart: number;
}

/**
 * Gives each character a voice by type, never the narrator's and never one
 * another character already has. Characters arrive in story order, so the same
 * cast always gets the same voices in every section.
 */
export function assignCharacterVoices(
	characters: SectionDialogue["characters"],
	narratorVoice: string,
): Map<string, string> {
	const used = new Set([narratorVoice]);
	const voices = new Map<string, string>();
	for (const character of characters) {
		const pool = CHARACTER_VOICES[character.voiceType];
		const voice =
			pool.find((candidate) => !used.has(candidate)) ??
			Object.values(CHARACTER_VOICES)
				.flat()
				.find((candidate) => !used.has(candidate)) ??
			pool[0];
		used.add(voice);
		voices.set(character.name, voice);
	}
	return voices;
}

/** Splits section text into narrator and character turns, quotation marks removed. */
export function dialogueTurns(
	text: string,
	quotes: DialogueQuotes,
	dialogue: SectionDialogue,
	narratorVoice: string,
	languageStyle: string,
	characterVoices = assignCharacterVoices(dialogue.characters, narratorVoice),
): SpeechTurn[] {
	const speakerIds = new Map(
		dialogue.characters.map((character, index) => [
			character.name,
			`Character${index + 1}`,
		]),
	);
	const voiceTypes = new Map(
		dialogue.characters.map((character) => [
			character.name,
			character.voiceType,
		]),
	);
	let cursor = 0;
	return dialogueSegments(text, quotes).flatMap((segment): SpeechTurn[] => {
		const textStart = cursor;
		cursor += segment.text.length;
		if (segment.dialogueIndex === undefined) {
			// Punctuation left over from the quotation (", sagt er.") would read as
			// part of the previous speaker's line.
			const narration = segment.text.replace(/^[\s,;:.]+/u, "").trim();
			return narration
				? [
						{
							speaker: "Narrator",
							voice: narratorVoice,
							text: narration,
							style: languageStyle,
							textStart,
						},
					]
				: [];
		}
		const line = dialogue.lines[segment.dialogueIndex];
		const voiceType = line && voiceTypes.get(line.speaker);
		const voice = line && characterVoices.get(line.speaker);
		const spoken = segment.text.slice(1, -1).trim();
		if (!line || !voiceType || !voice || !spoken) {
			throw new Error("Dialogue attribution does not match the section.");
		}
		return [
			{
				speaker: speakerIds.get(line.speaker) ?? "Character",
				voice,
				text: spoken,
				style: `${languageStyle} Speak as ${VOICE_TYPE_STYLE[voiceType]}. Delivery: ${line.delivery}.`,
				textStart,
			},
		];
	});
}

/**
 * Groups consecutive turns into requests of at most two voices, the most a
 * Gemini multi-speaker request accepts, cutting only where a third would join.
 */
export function groupSpeechTurns(turns: SpeechTurn[]): SpeechTurn[][] {
	const groups: SpeechTurn[][] = [];
	for (const turn of turns) {
		const current = groups[groups.length - 1];
		const voices = new Set(current?.map((item) => item.voice));
		if (current && (voices.has(turn.voice) || voices.size < 2)) {
			current.push(turn);
		} else {
			groups.push([turn]);
		}
	}
	return groups;
}

/**
 * Narrates one section with a voice per speaker, through the Interactions API.
 * Each request's measured duration and text range are returned as segments,
 * so highlighting can follow the real boundaries instead of one estimate.
 */
export async function synthesizeGeminiDialogue(
	model: GeminiTtsModel,
	turns: SpeechTurn[],
	textLength: number,
): Promise<SynthesizedSpeech> {
	const apiKey = process.env.GEMINI_API_KEY ?? "";
	if (!apiKey) throw new Error("Gemini API key is not configured.");
	const gap = Buffer.alloc(
		Math.round((SAMPLE_RATE * REQUEST_GAP_MS) / 1000) * 2,
	);
	const groups = groupSpeechTurns(turns);
	const pcm: Buffer[] = [];
	const segments: NarrationSegment[] = [];
	let seconds = 0;
	// Sequential on purpose: requests share a small per-minute quota.
	for (const [index, group] of groups.entries()) {
		if (index > 0) {
			pcm.push(gap);
			seconds += gap.length / BYTES_PER_SECOND;
		}
		const audio = await synthesizeGroup(apiKey, model, group);
		pcm.push(audio);
		segments.push({
			textStart: index === 0 ? 0 : group[0].textStart,
			textEnd: groups[index + 1]?.[0].textStart ?? textLength,
			start: seconds,
			end: seconds + audio.length / BYTES_PER_SECOND,
		});
		seconds += audio.length / BYTES_PER_SECOND;
	}
	return {
		segments,
		audio: pcmToWav(Buffer.concat(pcm)),
		extension: "wav",
		mimeType: "audio/wav",
		model,
		provider: "gemini",
		voice: [...new Set(turns.map((turn) => turn.voice))].join("+"),
	};
}

async function synthesizeGroup(
	apiKey: string,
	model: GeminiTtsModel,
	group: SpeechTurn[],
): Promise<Buffer> {
	const speakers = [
		...new Map(group.map((turn) => [turn.speaker, turn.voice])),
	];
	const multiSpeaker = speakers.length > 1;
	const body = {
		model,
		input: [
			{
				type: "user_input",
				content: group.map((turn) => ({
					type: "text",
					text: turn.text,
					annotations: [
						{
							type: "speech_metadata",
							...(multiSpeaker ? { speaker: turn.speaker } : {}),
							style: turn.style,
						},
					],
				})),
			},
		],
		response_format: {
			type: "audio",
			mime_type: "audio/l16",
			sample_rate: SAMPLE_RATE,
		},
		generation_config: {
			speech_config: multiSpeaker
				? {
						speakers: speakers.map(([speaker, voice]) => ({ speaker, voice })),
					}
				: [{ voice: group[0].voice }],
		},
	};
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await traceAiCall(
				{
					kind: "audio.speech",
					provider: "gemini",
					model,
					input: body,
					metadata: {
						voice: speakers.map(([, voice]) => voice).join("+"),
						attempt,
						dialogue: true,
					},
				},
				() => requestGroup(apiKey, body),
				(value) => ({ audioBytes: value.length }),
			);
		} catch (error) {
			const wait =
				error instanceof RetryableDialogueTtsError
					? error.retryAfterMs
					: error instanceof AiTraceError || error instanceof TypeError
						? 500 * attempt
						: undefined;
			if (wait === undefined || attempt === MAX_ATTEMPTS) throw error;
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}
}

class RetryableDialogueTtsError extends Error {
	constructor(
		message: string,
		readonly retryAfterMs: number,
	) {
		super(message);
	}
}

async function requestGroup(apiKey: string, body: unknown): Promise<Buffer> {
	const response = await fetch(
		"https://generativelanguage.googleapis.com/v1beta/interactions",
		{
			method: "POST",
			headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
			body: JSON.stringify(body),
		},
	);
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 500);
		const message = `Gemini dialogue TTS request failed: ${response.status} ${detail}`;
		if (response.status === 429 || response.status >= 500) {
			// The 429 body names the wait, e.g. "Please retry in 54s".
			const seconds = Number(detail.match(/retry in (\d+(?:\.\d+)?)s/i)?.[1]);
			const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : 1000;
			if (retryAfterMs <= MAX_RETRY_WAIT_MS) {
				throw new RetryableDialogueTtsError(message, retryAfterMs);
			}
		}
		throw new Error(message);
	}
	const json = (await response.json()) as {
		steps?: Array<{ content?: Array<{ type?: string; data?: string }> }>;
	};
	const audio = json.steps
		?.flatMap((step) => step.content ?? [])
		.find((part) => part.type === "audio" && part.data);
	if (!audio?.data) {
		throw new AiTraceError("Gemini dialogue TTS returned no audio.", {
			steps: json.steps?.length ?? 0,
		});
	}
	return Buffer.from(audio.data, "base64");
}
