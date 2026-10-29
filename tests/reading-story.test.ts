import assert from "node:assert/strict";
import { narrationWordAtTime } from "../src/exercise_screen/story/narrationTiming.ts";
import type { Language } from "../src/languages.ts";
import {
	DEFAULT_TEXT_MODEL,
	READING_STORY_MAX_TOKENS,
	SYSTEM_AI_PRESET,
} from "../src/models.ts";
import type { NarrationVoiceId } from "../src/narrationVoice.ts";
import {
	type NextStoryBrief,
	parseNextStoryBrief,
	STARTER_NEXT_STORY_BRIEF,
} from "../src/nextStoryBrief.ts";
import {
	dialogueSegments,
	findQuotations,
	parseDialogueAttribution,
	readingSectionDialogue,
	type StoryCharacter,
} from "../src/reading_story/dialogue.ts";
import { READING_STORY_LOGIC_MODEL } from "../src/reading_story/logicCheck.ts";
import {
	generateReadingManuscript,
	parseReadingManuscript,
	readingManuscriptMessages,
} from "../src/reading_story/manuscript.ts";
import {
	applyManuscriptCorrections,
	parseManuscriptCorrections,
	READING_STORY_PROOFREAD_MODEL,
} from "../src/reading_story/proofread.ts";
import {
	readingStorySentences,
	readingStorySplitMessages,
	splitReadingManuscript,
} from "../src/reading_story/split.ts";
import {
	buildReadingImageSections,
	generateReadingVisualPlan,
	imageVisualContext,
	parseImageScene,
	parseVisualElements,
	READING_STORY_VISUAL_MODEL,
	readingImageIndex,
	readingImageParts,
} from "../src/reading_story/visualPlan.ts";
import {
	prepareReadingStoryPlot,
	READING_STORY_PLOT_MODEL,
	readingStoryPlotMessages,
	readingStoryPlotReviewMessages,
} from "../src/readingStoryPlot.ts";
import {
	findUnfinishedReadingSave,
	type SavedStorySummary,
} from "../src/saves.ts";
import {
	completeAi,
	completeStructuredAi,
	translateWords,
} from "../src/server/aiService.ts";
import { AiTraceError } from "../src/server/aiTrace.ts";
import {
	assignCharacterVoices,
	dialogueTurns,
	groupSpeechTurns,
	synthesizeGeminiDialogue,
} from "../src/server/tts/geminiDialogueTts.ts";
import {
	type ChatMessage,
	type Complete,
	generateReadingStory,
	isSupportedReadingStory,
	parseReadingStory,
	type ReadingStory,
	readingImagePrompt,
	readingStoryMessages,
	readingVisualContext,
} from "../src/story.ts";
import {
	createReadingMedia,
	type ReadingMediaSection,
} from "../src/story_session/readingMedia.ts";
import type { StoryBackgroundImage } from "../src/storyBackground.ts";
import { storyWords } from "../src/storyVocabulary.ts";

const genre: Language = {
	id: "esperanto",
	label: "Esperanto",
	systemPrompt: "Write Esperanto stories.",
	seeds: [],
	dialogueQuotes: { open: "«", close: "»" },
} as unknown as Language;

const preferences = {
	prefer: ["Adult-respectful practical stories."],
	avoid: ["Ambiguous character locations."],
};
const nextStoryBrief: NextStoryBrief = {
	themeSuggestion: "seaside",
	narrativeScale: "simple",
	language: {
		focus: "Using pensi pri",
		progression: "reinforce",
		complexity: "simpler",
		calibrationSnippets: ["Ivo pensas pri hieraŭ."],
	},
};

const manuscriptText = [
	"Mara atendis ĉe la stacidomo.",
	"Ŝi tenis malgrandan mapon.",
	"La trajno alvenis malfrue.",
	"Mara demandis pri la vojo.",
	"Konduktoro montris la duan kajon.",
	"Ŝi dankis lin.",
	"Mara transiris la ponton.",
	"Ŝi trovis la ĝustan trajnon.",
	"La pordoj malfermiĝis.",
	"Mara eniris la vagonon.",
	"Ŝi sidis apud la fenestro.",
	"La vojaĝo komenciĝis trankvile.",
].join(" ");

const manuscript = {
	title: "La Ĝusta Trajno",
	text: manuscriptText,
	characters: [],
	dialogue: [],
	cast: [{ name: "Mara", identity: "a young woman travelling alone" }],
};

const visualElements = [
	{
		name: "Mara",
		description:
			"A woman in her thirties with short black hair and a green coat.",
	},
	{ name: "the station", description: "Stone platforms and a glass roof." },
	{ name: "the ticket", description: "A small yellow paper ticket." },
];

/**
 * Answers the visual planner's look and scene calls; any other call is left to
 * `otherwise`. Scenes show Mara at the station; the ticket stays out of them.
 */
function visualPlanStep(
	system: string,
	otherwise: () => string | Promise<string>,
) {
	if (system.includes("shared visual look")) {
		return JSON.stringify({ visualElements, properNames: ["Mara"] });
	}
	if (system.includes("Plan one illustration")) {
		return JSON.stringify({
			visible: ["Mara", "the station"],
			prompt: "Mara checks the map.",
		});
	}
	return otherwise();
}

function finalStoryJson(
	partCount = 5,
	imageCount = readingImageParts(partCount).length,
) {
	return JSON.stringify({
		title: manuscript.title,
		storySummary: "Mara finds the correct train.",
		languageFocus: nextStoryBrief.language.focus,
		visualElements,
		properNames: ["Mara"],
		imageScenes: Array.from({ length: imageCount }, (_, index) => ({
			visible: ["Mara", "the station"],
			prompt: `Settled scene ${index + 1}.`,
		})),
		parts: Array.from({ length: partCount }, (_, index) => ({
			text: `Esperanta teksto de parto ${index + 1}. Ĝi estas kompleta.`,
		})),
	});
}

// --- Plot preparation --------------------------------------------------------

const plotMessages = readingStoryPlotMessages("gremlins", preferences);
assert.match(plotMessages[0].content, /short story plot/i);
assert.match(plotMessages[0].content, /narrative guidance/i);
const plotContext = JSON.parse(plotMessages[1].content);
assert.equal(plotContext.storySubject, "gremlins");
assert.deepEqual(plotContext.preferences, preferences);
assert.match(plotContext.narrativeGuidance, /introducing a language/i);
assert.match(
	plotContext.characterNameGuidance,
	/Prefer Esperanto character names/i,
);
assert.doesNotMatch(
	plotMessages[1].content,
	/Ivo pensas|Using pensi pri|seaside/,
	"plot invention must not receive the pedagogical brief",
);
assert.match(
	JSON.parse(
		readingStoryPlotMessages("gremlins", preferences, "simple")[1].content,
	).narrativeGuidance,
	/beginner language practice/i,
);
const openPlotContext = JSON.parse(
	readingStoryPlotMessages(undefined, preferences, "minimal", [
		{
			genreId: "esperanto",
			motif: "a lost red ball",
			protagonist: "young child",
			setting: "city park",
			elements: ["red ball", "bench"],
		},
	])[1].content,
);
assert.equal(openPlotContext.storySubject, undefined);
assert.deepEqual(openPlotContext.preferences, preferences);
assert.equal(openPlotContext.recentStories[0].motif, "a lost red ball");
assert.match(readingStoryPlotMessages(undefined)[0].content, /choose.*freely/i);
assert.match(
	plotMessages[0].content,
	/two or more characters meet.*speak to each other/is,
);
assert.match(plotMessages[0].content, /do not write out the spoken lines/);
assert.match(
	readingStoryPlotReviewMessages("A draft.")[0].content,
	/keep moments where characters speak/i,
);
assert.equal(
	JSON.parse(
		readingStoryPlotMessages(
			undefined,
			preferences,
			"minimal",
			[],
			genre,
			"Avoid plurals and direct objects.",
		)[1].content,
	).languageLimits,
	"Avoid plurals and direct objects.",
);
assert.equal(
	"languageLimits" in
		JSON.parse(readingStoryPlotMessages(undefined)[1].content),
	false,
);
const germanPlotContext = JSON.parse(
	readingStoryPlotMessages(undefined, preferences, "minimal", [], {
		...genre,
		id: "german",
		label: "German",
	})[1].content,
);
assert.match(
	germanPlotContext.characterNameGuidance,
	/Prefer German character names/i,
);

const reviewMessages = readingStoryPlotReviewMessages("A draft plot.");
assert.match(reviewMessages[0].content, /Original draft:/);
assert.match(reviewMessages[0].content, /Improved draft:/);
assert.match(reviewMessages[0].content, /no information or consequence/i);
assert.deepEqual(JSON.parse(reviewMessages[1].content), {
	draft: "A draft plot.",
});

const plotCalls: Array<Parameters<Complete>> = [];
const { plot: preparedPlot } = await prepareReadingStoryPlot(
	async (...args) => {
		plotCalls.push(args);
		return plotCalls.length === 1
			? "  Mia meets Amelia and finds Mia's key.  "
			: "OK";
	},
	"gremlins",
	preferences,
);
assert.match(preparedPlot, /\bMia\b/);
assert.match(preparedPlot, /\bAmelia\b/);
assert.equal(
	JSON.parse(plotCalls[1]?.[0][1]?.content ?? "").draft,
	preparedPlot,
);
assert.deepEqual(
	plotCalls.map(([, , options]) => options),
	[
		{ model: READING_STORY_PLOT_MODEL, reasoningEffort: "low" },
		{ model: READING_STORY_PLOT_MODEL, reasoningEffort: "medium" },
	],
);
console.log("checked reading story: plot names follow language guidance");

assert.deepEqual(
	parseNextStoryBrief(STARTER_NEXT_STORY_BRIEF),
	STARTER_NEXT_STORY_BRIEF,
);
assert.equal(
	parseNextStoryBrief({ ...STARTER_NEXT_STORY_BRIEF, history: [] }),
	null,
);
assert.equal(
	parseNextStoryBrief({
		...STARTER_NEXT_STORY_BRIEF,
		narrativeScale: "advanced",
	}),
	null,
);
console.log("checked reading story: learner handoff remains strict");

// --- Final immutable manuscript ---------------------------------------------

const manuscriptMessages = readingManuscriptMessages(
	genre,
	"A commuter finds the correct train.",
	nextStoryBrief,
	preferences,
);
assert.match(manuscriptMessages[0].content, /concise Esperanto title/i);
assert.match(manuscriptMessages[0].content, /final uninterrupted prose/i);
assert.match(manuscriptMessages[0].content, /explicit preferences/i);
assert.match(manuscriptMessages[0].content, /Do not assume an adult or child/i);
assert.doesNotMatch(manuscriptMessages[0].content, /adult-respectful/i);
assert.match(manuscriptMessages[0].content, /Do not create sections/i);
assert.match(manuscriptMessages[0].content, /required accusative/i);
assert.match(manuscriptMessages[0].content, /do not insert English glosses/i);
assert.match(
	manuscriptMessages[0].content,
	/Do not force it into every sentence/i,
);
assert.doesNotMatch(
	manuscriptMessages[0].content,
	/imageScenes|visualElements/,
);
const authoringContext = JSON.parse(
	manuscriptMessages[1].content.split("\n\n").at(-1) ?? "",
);
assert.equal(authoringContext.storyPlot, "A commuter finds the correct train.");
assert.equal(authoringContext.narrativeScale, "simple");
assert.match(authoringContext.lengthGuidance, /160-260 Esperanto words/);
assert.match(authoringContext.languageGuidance, /shorter, more concrete/i);
assert.deepEqual(authoringContext.language, nextStoryBrief.language);
assert.deepEqual(authoringContext.preferences, preferences);
const absoluteBeginnerContext = JSON.parse(
	readingManuscriptMessages(
		genre,
		"A person arrives and greets a neighbor.",
		STARTER_NEXT_STORY_BRIEF,
	)[1]
		.content.split("\n\n")
		.at(-1) ?? "",
);
assert.match(absoluteBeginnerContext.languageGuidance, /very short, concrete/i);
assert.match(absoluteBeginnerContext.languageGuidance, /one clause/i);
assert.match(
	absoluteBeginnerContext.languageGuidance,
	/a few simple direct objects/i,
);
assert.match(
	absoluteBeginnerContext.languageGuidance,
	/Preserve every plot event/i,
);
assert.deepEqual(
	parseReadingManuscript(JSON.stringify(manuscript), genre),
	manuscript,
);
assert.throws(() => parseReadingManuscript('{"title":"Only a title"}', genre));
assert.throws(
	() =>
		parseReadingManuscript(
			JSON.stringify({ ...manuscript, cast: [{ name: "Mara" }] }),
			genre,
		),
	/cast member needs a name and an identity/,
);

let manuscriptAttempts = 0;
const repairedManuscript = await generateReadingManuscript(
	async (_messages, maxTokens, options) => {
		manuscriptAttempts += 1;
		assert.equal(maxTokens, READING_STORY_MAX_TOKENS);
		assert.deepEqual(
			options,
			manuscriptAttempts === 1
				? { reasoningEffort: "medium" }
				: SYSTEM_AI_PRESET,
		);
		return manuscriptAttempts === 1 ? "{oops" : JSON.stringify(manuscript);
	},
	genre,
	"Reviewed plot.",
	nextStoryBrief,
	preferences,
	"medium",
);
assert.deepEqual(repairedManuscript, manuscript);
console.log("checked reading story: author owns only final immutable prose");

// --- Semantic splitting ------------------------------------------------------

assert.deepEqual(
	readingStorySentences(manuscriptText),
	[...manuscriptText.matchAll(/[^.]+\.\s*/gu)].map((match) => match[0]),
);
assert.deepEqual(
	readingStorySentences("Lina demandas: «Saluton?» Tomas ridetas.").map(
		(sentence) => sentence.trim(),
	),
	["Lina demandas: «Saluton?»", "Tomas ridetas."],
);
const splitMessages = readingStorySplitMessages(manuscript);
assert.match(splitMessages[0].content, /sentences are immutable/i);
assert.match(splitMessages[0].content, /Do not return prose/i);
assert.match(splitMessages[0].content, /one coherent story event or beat/i);
const splitContext = JSON.parse(splitMessages[1].content);
assert.equal(splitContext.sentences.length, 12);
assert.equal(splitContext.sentences[0].number, 1);
assert.equal(splitContext.sentences[0].wordCount, 5);
assert.deepEqual(splitContext.allowedPartCount, { min: 2, max: 8 });
assert.equal("preferredPartCount" in splitContext, false);
assert.equal("languageComplexity" in splitContext, false);

const splitCalls: Array<Parameters<Complete>> = [];
const parts = await splitReadingManuscript(async (...args) => {
	splitCalls.push(args);
	return '{"breakAfterSentence":[4,8]}';
}, manuscript);
assert.equal(parts.length, 3);
assert.equal(
	parts.map((part) => part.text).join(" "),
	manuscript.text,
	"Luna boundaries must preserve every character of prose after whitespace normalization.",
);
assert.deepEqual(splitCalls[0][2], { model: DEFAULT_TEXT_MODEL });

let trailingFinalAttempts = 0;
const trailingFinalParts = await splitReadingManuscript(async () => {
	trailingFinalAttempts += 1;
	return '{"breakAfterSentence":[4,8,12]}';
}, manuscript);
assert.equal(trailingFinalAttempts, 1);
assert.equal(trailingFinalParts.length, 3);
assert.equal(
	trailingFinalParts.map((part) => part.text).join(" "),
	manuscript.text,
);

let splitAttempts = 0;
const retriedParts = await splitReadingManuscript(async (messages) => {
	splitAttempts += 1;
	if (splitAttempts === 1) return '{"breakAfterSentence":[999]}';
	assert.match(messages.at(-1)?.content ?? "", /invalid boundaries/i);
	return '{"breakAfterSentence":[6]}';
}, manuscript);
assert.equal(splitAttempts, 2);
assert.equal(retriedParts.length, 2);
assert.equal(retriedParts.map((part) => part.text).join(" "), manuscript.text);
console.log(
	"checked reading story: Luna selects boundaries but cannot rewrite",
);

// --- Dialogue attribution ----------------------------------------------------

const guillemets = { open: "«", close: "»" };
const dialogueText =
	"Lina vidas Tomas. Ŝi demandas: «Ĉu vi venas? Mi atendas.» Tomas respondas: «Jes!» Ili iras. Lina diras: «Bone.»";
assert.equal(findQuotations(dialogueText, guillemets).length, 3);
assert.throws(() => findQuotations("«Saluton", guillemets), /never closed/);
assert.throws(() => findQuotations("Saluton»", guillemets), /no opening/);
assert.throws(() => findQuotations("«a «b» c»", guillemets), /inside/);
// Finnish opens and closes with the same mark.
assert.equal(
	findQuotations("Aino sanoo: ”Hei.” Matti sanoo: ”Moi.”", {
		open: "”",
		close: "”",
	}).length,
	2,
);

assert.deepEqual(
	readingStorySentences(dialogueText, guillemets).map((sentence) =>
		sentence.trim(),
	),
	[
		"Lina vidas Tomas.",
		"Ŝi demandas: «Ĉu vi venas? Mi atendas.»",
		"Tomas respondas: «Jes!»",
		"Ili iras.",
		"Lina diras: «Bone.»",
	],
	"A sentence never ends inside a quotation.",
);
assert.deepEqual(
	readingStorySentences(
		"Lina demandas: «Ĉu vi venas?» kaj ridetas. Tomas venas.",
		guillemets,
	).map((sentence) => sentence.trim()),
	["Lina demandas: «Ĉu vi venas?» kaj ridetas.", "Tomas venas."],
	"Lowercase narration after a quotation continues the sentence.",
);

const characters = [
	{ name: "Lina", voiceType: "woman" },
	{ name: "Tomas", voiceType: "boy" },
	{ name: "Bruno", voiceType: "older man" },
];
const cast = [
	{ name: "Lina", identity: "a young woman" },
	{ name: "Tomas", identity: "Lina's younger brother, a boy" },
];
const dialogue = [
	{ speaker: "Lina", delivery: "curious" },
	{ speaker: "Tomas", delivery: "eager" },
	{ speaker: "Lina", delivery: "soft, content" },
];
assert.deepEqual(
	parseDialogueAttribution(dialogueText, guillemets, characters, dialogue),
	{ characters: characters.slice(0, 2), dialogue },
	"Characters who never speak are dropped.",
);
assert.throws(
	() =>
		parseDialogueAttribution(
			dialogueText,
			guillemets,
			characters,
			dialogue.slice(0, 2),
		),
	/3 «…» quotations but dialogue has 2/,
);
assert.throws(
	() =>
		parseDialogueAttribution(dialogueText, guillemets, characters, [
			...dialogue.slice(0, 2),
			{ speaker: "Narrator", delivery: "calm" },
		]),
	/speaker listed in characters/,
);
assert.throws(
	() =>
		parseDialogueAttribution(
			dialogueText,
			guillemets,
			[{ name: "Lina", voiceType: "wizard" }],
			[],
		),
	/voiceType/,
);

assert.deepEqual(
	dialogueSegments("Tomas respondas: «Jes!» Ili iras.", guillemets, 1),
	[
		{ text: "Tomas respondas: " },
		{ text: "«Jes!»", dialogueIndex: 1 },
		{ text: " Ili iras." },
	],
);

const dialogueMessages = readingManuscriptMessages(
	genre,
	"Lina asks Tomas to come along.",
	nextStoryBrief,
);
assert.match(
	dialogueMessages[0].content,
	/Enclose every spoken line in « and »/,
);
assert.match(
	dialogueMessages[0].content,
	/does not end with an exclamation mark/,
);
assert.match(dialogueMessages[0].content, /never write an unnatural line/);
assert.match(dialogueMessages[0].content, /names and facts they could know/);
assert.match(
	JSON.parse(dialogueMessages[1].content.split("\n\n").at(-1) ?? "")
		.lengthGuidance,
	/at most 6 quotations/,
);

let dialogueRepairPrompt = "";
const repairedDialogue = await generateReadingManuscript(
	async (messages) => {
		if (!dialogueRepairPrompt && messages[0].content.startsWith("Author")) {
			return JSON.stringify({
				title: "Lina kaj Tomas",
				text: dialogueText,
				characters,
				dialogue: dialogue.slice(0, 2),
				cast,
			});
		}
		dialogueRepairPrompt = messages[0].content;
		assert.match(messages[1].content, /3 «…» quotations/);
		return JSON.stringify({
			title: "Lina kaj Tomas",
			text: dialogueText,
			characters,
			dialogue,
			cast,
		});
	},
	genre,
	"Lina asks Tomas to come along.",
	nextStoryBrief,
);
assert.match(dialogueRepairPrompt, /exactly one entry per «…» quotation/);
assert.equal(repairedDialogue.dialogue.length, 3);
console.log("checked reading story: dialogue attribution follows quotations");

// --- Voicing a section's dialogue ---------------------------------------------

const voicedParts = [
	{ text: "Lina vidas Tomas. Ŝi demandas: «Ĉu vi venas? Mi atendas.»" },
	{ text: "Ili iras." },
	{ text: "Tomas respondas: «Jes!» Lina diras: «Bone.»" },
];
const castCharacters = characters.slice(0, 2) as StoryCharacter[];
assert.equal(
	readingSectionDialogue(voicedParts, castCharacters, dialogue, 2, guillemets),
	undefined,
	"A section without quotations is narrated in one voice.",
);
const thirdSection = readingSectionDialogue(
	voicedParts,
	castCharacters,
	dialogue,
	3,
	guillemets,
);
assert.deepEqual(thirdSection?.lines, dialogue.slice(1));
assert.deepEqual(
	thirdSection?.characters.map((character) => character.name),
	["Lina", "Tomas"],
);
assert.equal(
	readingSectionDialogue(voicedParts, undefined, undefined, 1, guillemets),
	undefined,
);

const twoMen = assignCharacterVoices(
	[
		{ name: "Toma", voiceType: "man" },
		{ name: "Niko", voiceType: "man" },
		{ name: "Mara", voiceType: "woman" },
	],
	"Charon",
);
assert.notEqual(twoMen.get("Toma"), "Charon", "Never the narrator's voice.");
assert.notEqual(twoMen.get("Toma"), twoMen.get("Niko"));
assert.equal(new Set(twoMen.values()).size, 3);

const fiveBoys = assignCharacterVoices(
	["A", "B", "C", "D", "E"].map((name) => ({
		name,
		voiceType: "boy" as const,
	})),
	"Puck",
);
assert.equal(
	fiveBoys.get("E"),
	"Kore",
	"A type out of voices falls back to a related type, not any voice.",
);

const sisters = [
	{ name: "Ana", voiceType: "woman" },
	{ name: "Eva", voiceType: "woman" },
] as StoryCharacter[];
const sistersParts = [
	{ text: "«Saluton», diras Ana. «Saluton», diras Eva." },
	{ text: "«Ĝis», diras Eva." },
];
const sistersDialogue = [
	{ speaker: "Ana", delivery: "warm" },
	{ speaker: "Eva", delivery: "warm" },
	{ speaker: "Eva", delivery: "sad" },
];
const evaVoices = [1, 2].map(
	(partIndex) =>
		dialogueTurns(
			sistersParts[partIndex - 1].text,
			guillemets,
			readingSectionDialogue(
				sistersParts,
				sisters,
				sistersDialogue,
				partIndex,
				guillemets,
			) ?? { characters: [], lines: [] },
			"Iapetus",
			"",
		).findLast((item) => item.speaker !== "Narrator")?.voice,
);
assert.equal(
	evaVoices[0],
	evaVoices[1],
	"A character keeps one voice when an earlier one stays silent.",
);

const turns = dialogueTurns(
	voicedParts[2].text,
	guillemets,
	thirdSection ?? { characters: [], lines: [] },
	"Iapetus",
	"Speak Esperanto.",
);
assert.deepEqual(
	turns.map((turn) => [turn.speaker, turn.text]),
	[
		["Narrator", "Tomas respondas:"],
		["Character2", "Jes!"],
		["Narrator", "Lina diras:"],
		["Character1", "Bone."],
	],
);
assert.match(
	turns[1].style,
	/^Speak Esperanto\. Speak as a young boy, a child: light, bright, childlike\. Delivery: eager\.$/,
);
assert.equal(turns[0].style, "Speak Esperanto.");
assert.throws(() =>
	dialogueTurns(
		"«Jes!»",
		guillemets,
		{ characters: [], lines: [] },
		"Iapetus",
		"",
	),
);

assert.deepEqual(
	dialogueTurns(
		"«Bone», diras Lina.",
		guillemets,
		{
			characters: castCharacters,
			lines: [{ speaker: "Lina", delivery: "soft" }],
		},
		"Iapetus",
		"",
	).map((item) => item.text),
	["Bone", "diras Lina."],
	"Punctuation after a quotation never starts the narrator's turn.",
);

const turn = (voice: string) => ({
	speaker: voice,
	voice,
	text: voice,
	style: "",
});
assert.deepEqual(
	groupSpeechTurns(["N", "B", "N", "A", "N", "B", "N"].map(turn)).map((group) =>
		group.map((item) => item.voice).join(""),
	),
	["NBN", "AN", "BN"],
	"Requests hold at most two voices and cut only where a third joins.",
);
console.log("checked reading story: dialogue voices are grouped per request");

// --- Measured segment timing ---------------------------------------------------

// Two requests, [N Tomas N] and [Lina], each answered with one second of audio.
const segmentText = "Tomas respondas: «Jes!» Lina diras: «Bone.»";
const segmentTurns = dialogueTurns(
	segmentText,
	guillemets,
	thirdSection ?? { characters: [], lines: [] },
	"Iapetus",
	"",
);
const realFetch = globalThis.fetch;
const realGeminiKey = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = "test-key";
globalThis.fetch = (async () =>
	new Response(
		JSON.stringify({
			steps: [
				{
					content: [
						{
							type: "audio",
							data: Buffer.alloc(48_000).toString("base64"),
						},
					],
				},
			],
		}),
	)) as typeof fetch;
const stitched = await synthesizeGeminiDialogue(
	"gemini-3.8-flash-lite-tts",
	segmentTurns,
	segmentText.length,
);
globalThis.fetch = realFetch;
process.env.GEMINI_API_KEY = realGeminiKey;
assert.deepEqual(
	stitched.segments?.map((segment) => [
		segmentText.slice(segment.textStart, segment.textEnd),
		segment.start,
		segment.end,
	]),
	[
		["Tomas respondas: «Jes!» Lina diras: ", 0, 1],
		["«Bone.»", 1.3, 2.3],
	],
	"Segments cover the whole text in order, with the pause between requests.",
);

const timedText = "Unu du. Tri kvar.";
const timedSegments = [
	{ textStart: 0, textEnd: 8, start: 0, end: 1 },
	{ textStart: 8, textEnd: timedText.length, start: 3, end: 4 },
];
assert.equal(narrationWordAtTime(timedText, 0.1, 4, timedSegments), 0);
assert.equal(
	narrationWordAtTime(timedText, 2, 4, timedSegments),
	4,
	"During a pause the segment's last word stays highlighted.",
);
assert.equal(
	narrationWordAtTime(timedText, 3.1, 4, timedSegments),
	8,
	"The next segment starts exactly at its measured time.",
);
assert.equal(
	narrationWordAtTime(timedText, 3.1, 4),
	12,
	"Without segments the estimate spans the whole recording.",
);
console.log("checked reading story: highlighting follows measured segments");

// --- Visual look and per-image scenes ---------------------------------------

const visualCalls: ChatMessage[][] = [];
const visualPlan = await generateReadingVisualPlan(
	async (messages) => {
		visualCalls.push(messages);
		return visualPlanStep(messages[0].content, () => {
			throw new Error("Unexpected visual call.");
		});
	},
	parts,
	manuscript.cast,
);
const callData = (messages: ChatMessage[]) =>
	JSON.parse(messages[1].content.split("\n\n").at(-1) ?? "");
// One look call, then one scene call per image.
assert.equal(visualCalls.length, 3);
const [lookCall, ...sceneCalls] = visualCalls;
assert.match(lookCall[0].content, /shared visual look/i);
assert.match(lookCall[0].content, /Never state in a description where/i);
assert.deepEqual(Object.keys(callData(lookCall)), ["cast", "storyParts"]);
assert.deepEqual(callData(lookCall).cast, manuscript.cast);
assert.deepEqual(
	callData(lookCall).storyParts,
	parts.map((part) => part.text),
);
const sceneSystem = sceneCalls[0][0].content;
assert.match(sceneSystem, /still with the others is visible/i);
assert.match(sceneSystem, /never use a collective/i);
assert.match(sceneSystem, /No other people or creatures are visible/);
assert.deepEqual(Object.keys(callData(sceneCalls[0])), [
	"cast",
	"storyParts",
	"visualElements",
	"section",
]);
assert.deepEqual(callData(sceneCalls[0]).visualElements, visualElements);
// Each image shows only the first part of its pair, never a blend of both.
assert.deepEqual(
	sceneCalls.map((call) => callData(call).section),
	[
		{ part: 1, text: parts[0].text },
		{ part: 3, text: parts[2].text },
	],
);
assert.equal(visualPlan.imageScenes.length, 2);
assert.deepEqual(visualPlan.properNames, ["Mara"]);
// Only elements present at the moment reach the image, worded as the look defined them.
assert.equal(
	imageVisualContext(visualPlan.visualElements, visualPlan.imageScenes[0]),
	"Mara: A woman in her thirties with short black hair and a green coat.\nthe station: Stone platforms and a glass roof.",
);

assert.deepEqual(buildReadingImageSections([parts[0]]), [
	{ number: 1, sourceParts: [1], shownPart: 1, text: parts[0].text },
]);

// Odd parts and the last part get an image; the others keep the one before.
assert.deepEqual(readingImageParts(4), [1, 3, 4]);
assert.deepEqual(readingImageParts(5), [1, 3, 5]);
assert.deepEqual(readingImageParts(1), [1]);
assert.deepEqual(
	[1, 2, 3, 4].map((part) => readingImageIndex(part, 4)),
	[0, 0, 1, 2],
);
assert.deepEqual(
	buildReadingImageSections(
		["One.", "Two.", "Three.", "Four."].map((text) => ({ text })),
	).map(({ sourceParts, shownPart }) => ({ sourceParts, shownPart })),
	[
		{ sourceParts: [1, 2], shownPart: 1 },
		{ sourceParts: [3], shownPart: 3 },
		{ sourceParts: [4], shownPart: 4 },
	],
);

assert.throws(
	() => parseVisualElements([visualElements[0], visualElements[0]]),
	/more than once/,
);
assert.throws(
	() =>
		parseImageScene({ visible: ["Mara", "the dog"], prompt: "A scene." }, [
			"Mara",
		]),
	/unknown visual elements: the dog/,
);

const sceneRepairCalls: ChatMessage[][] = [];
const repairedVisualPlan = await generateReadingVisualPlan(
	async (messages) => {
		sceneRepairCalls.push(messages);
		const system = messages[0].content;
		if (system.includes("Repair the supplied rejectedOutput")) {
			return JSON.stringify({ visible: ["Mara"], prompt: "Mara boards." });
		}
		if (system.includes("Plan one illustration")) {
			return JSON.stringify({ visible: ["Mara", "the dog"], prompt: "X." });
		}
		return visualPlanStep(system, () => {
			throw new Error("Unexpected visual call.");
		});
	},
	parts,
	manuscript.cast,
);
assert.deepEqual(
	repairedVisualPlan.imageScenes.map((scene) => scene.prompt),
	["Mara boards.", "Mara boards."],
);
const sceneRepair = sceneRepairCalls.find((call) =>
	call[0].content.includes("Repair the supplied rejectedOutput"),
);
assert.ok(sceneRepair);
assert.match(callData(sceneRepair).validationFailure, /the dog/);
assert.match(callData(sceneRepair).originalRequest, /Plan one illustration/);
console.log("checked reading story: visual planning follows settled parts");

// --- Thin orchestration ------------------------------------------------------

// The logic check fixes a stranger thanked by a name nobody said.
const logicOriginal = "Ŝi dankis lin.";
const logicCorrected = "Ŝi dankis la konduktoron.";
const logicCheckedText = manuscriptText.replace(logicOriginal, logicCorrected);

const pipelineCalls: Array<{
	maxTokens: number;
	messages: ChatMessage[];
	options?: Parameters<Complete>[2];
}> = [];
const generated = await generateReadingStory(
	async (messages, maxTokens, options) => {
		pipelineCalls.push({ messages, maxTokens, options });
		const system = messages[0]?.content ?? "";
		if (system.includes("Prepare a short story plot")) {
			return "A commuter asks for directions and finds the correct train.";
		}
		if (system.includes("reviewing a short story draft")) return "OK";
		if (system.includes("finished manuscript")) {
			return JSON.stringify(manuscript);
		}
		if (system.includes("careful story editor")) {
			assert.equal(
				JSON.parse(messages[1]?.content ?? "{}").text,
				manuscript.text,
			);
			return JSON.stringify({
				corrections: [{ original: logicOriginal, corrected: logicCorrected }],
			});
		}
		if (system.includes("proofreader")) {
			// Proofreading sees the logic check's edits, so it also checks them.
			assert.equal(
				JSON.parse(messages[1]?.content ?? "{}").text,
				logicCheckedText,
			);
			return '{"corrections":[]}';
		}
		if (system.includes("presentation parts")) {
			return '{"breakAfterSentence":[4,8]}';
		}
		return visualPlanStep(system, () => {
			throw new Error(`Unexpected pipeline call: ${system.slice(0, 80)}`);
		});
	},
	genre,
	preferences,
	undefined,
	{ nextStoryBrief, reasoningEffort: "medium" },
);
assert.equal(generated.parts.length, 3);
assert.equal(generated.imageScenes.length, 2);
assert.equal(
	generated.storySummary,
	"A commuter asks for directions and finds the correct train.",
);
assert.equal(generated.languageFocus, nextStoryBrief.language.focus);
assert.deepEqual(generated.generationBrief, nextStoryBrief);
assert.deepEqual(
	pipelineCalls.map(({ options }) => options),
	[
		{ model: READING_STORY_PLOT_MODEL, reasoningEffort: "low" },
		{ model: READING_STORY_PLOT_MODEL, reasoningEffort: "medium" },
		{ reasoningEffort: "medium" },
		{ model: READING_STORY_LOGIC_MODEL, reasoningEffort: "medium" },
		{ model: READING_STORY_PROOFREAD_MODEL, reasoningEffort: "medium" },
		{ model: DEFAULT_TEXT_MODEL },
		{ model: READING_STORY_VISUAL_MODEL, reasoningEffort: "low" },
		{ model: READING_STORY_VISUAL_MODEL, reasoningEffort: "low" },
		{ model: READING_STORY_VISUAL_MODEL, reasoningEffort: "low" },
	],
);
assert.equal(
	generated.parts.map((part) => part.text).join(" "),
	logicCheckedText,
);
console.log(
	"checked reading story: staged pipeline plans one scene call per image",
);

// --- Proofreading --------------------------------------------------------------

const proofreadSource =
	"Marco prope est. Livia dicit: «Marco, veni.» Una sacculus est. Una sacculus est.";
const proofread = applyManuscriptCorrections(
	proofreadSource,
	parseManuscriptCorrections(
		JSON.stringify({
			corrections: [
				{ original: "Marco prope est.", corrected: "Marcus prope est." },
				// Ambiguous: occurs twice, so it must not be applied anywhere.
				{ original: "Una sacculus est.", corrected: "Unus sacculus est." },
				// A rewrite rather than a local correction.
				{
					original: "Livia dicit: «Marco, veni.»",
					corrected:
						"Livia, quae in statione diu exspectat, Marcum magna voce vocat et dicit: «Marce, veni celeriter ad me.»",
				},
				// Adds dialogue marks, which would shift positional attribution.
				{
					original: "Livia dicit: «Marco, veni.»",
					corrected: "Livia dicit: «Marce», «veni».",
				},
				// Not in the text at all.
				{ original: "Tramen venit.", corrected: "Tramen venit!" },
				{ original: "Marcus", reason: "missing corrected field" },
			],
		}),
	),
	{ open: "«", close: "»" },
);
assert.equal(
	proofread.text,
	"Marcus prope est. Livia dicit: «Marco, veni.» Una sacculus est. Una sacculus est.",
);
assert.equal(proofread.applied.length, 1);

const failedProofread = await generateReadingStory(
	async (messages) => {
		const system = messages[0]?.content ?? "";
		if (system.includes("Prepare a short story plot")) return "A plot.";
		if (system.includes("reviewing a short story draft")) return "OK";
		if (system.includes("finished manuscript"))
			return JSON.stringify(manuscript);
		if (system.includes("careful story editor")) {
			throw new Error("provider down");
		}
		if (system.includes("proofreader")) throw new Error("provider down");
		if (system.includes("presentation parts")) {
			return '{"breakAfterSentence":[4,8]}';
		}
		return visualPlanStep(system, () => {
			throw new Error(`Unexpected pipeline call: ${system.slice(0, 80)}`);
		});
	},
	genre,
	preferences,
	undefined,
	{ nextStoryBrief },
);
assert.equal(
	failedProofread.parts.map((part) => part.text).join(" "),
	manuscript.text,
);
console.log(
	"checked reading story: proofreading applies only local corrections",
);
console.log(
	"checked reading story: a failed logic check or proofread keeps the manuscript",
);

// --- Final story validation and dynamic media cadence ------------------------

const parsed = parseReadingStory(finalStoryJson(5));
assert.equal(parsed.parts.length, 5);
assert.equal(parsed.imageScenes.length, 3);
assert.equal(readingImagePrompt(parsed, 1), "Settled scene 1.");
assert.equal(readingImagePrompt(parsed, 2), "Settled scene 1.");
assert.equal(readingImagePrompt(parsed, 3), "Settled scene 2.");
assert.equal(readingImagePrompt(parsed, 5), "Settled scene 3.");
assert.match(readingVisualContext(parsed, 3), /^Mara: .*\nthe station: /);
assert.doesNotMatch(readingVisualContext(parsed, 3), /ticket/);
assert.throws(() => parseReadingStory(finalStoryJson(5, 2)));
assert.throws(() => parseReadingStory(finalStoryJson(9)));
assert.throws(() =>
	parseReadingStory(
		finalStoryJson(3).replace('"visualElements":', '"missingVisualElements":'),
	),
);
assert.deepEqual(
	parseReadingStory(
		`Here is the story:\n\`\`\`json\n${finalStoryJson(5)}\n\`\`\``,
	),
	parsed,
);
assert.deepEqual(parseReadingStory(`${finalStoryJson(5)}}`), parsed);

// A story saved before a format change is recognised, so an unfinished one
// can never block a new story it cannot be continued into.
const { visualElements: _, imageScenes: __, ...outdatedStory } = parsed;
assert.ok(isSupportedReadingStory(parsed));
assert.ok(
	!isSupportedReadingStory({
		...outdatedStory,
		visualContext: "Old shared context.",
		imagePrompts: ["One.", "Two.", "Three."],
	}),
);
const unfinishedSave = (
	id: string,
	isOutdatedReadingStory: boolean,
): SavedStorySummary => ({
	id,
	genreId: genre.id,
	title: id,
	createdAt: "2026-10-29T00:00:00.000Z",
	updatedAt: "2026-10-29T00:00:00.000Z",
	preview: "",
	phase: "reading",
	isReadingStory: true,
	isOutdatedReadingStory,
});
assert.equal(findUnfinishedReadingSave([unfinishedSave("old", true)]), null);
assert.equal(
	findUnfinishedReadingSave([
		unfinishedSave("old", true),
		unfinishedSave("current", false),
	])?.id,
	"current",
);
console.log(
	"checked reading story: an outdated unfinished save never blocks a new story",
);
console.log(
	"checked reading story: variable part and image counts are validated",
);

assert.deepEqual(
	storyWords(
		["Léo vidas Léon. Ana salutas Léo-n. La stacidomo estas granda."],
		["Léo", "Ana"],
	),
	["vidas", "salutas", "la", "stacidomo", "estas", "granda"],
);
console.log("checked reading vocabulary: Unicode names remain whole tokens");

// Structured provider output must preserve curly Esperanto dialogue.
const storyWithCurlyDialogue = finalStoryJson(3).replace(
	"Esperanta teksto de parto 1. Ĝi estas kompleta.",
	"Mara diras: “Jes, la ĉambro estas preta.”",
);
process.env.OPENAI_API_KEY = "test-key";
let requestedReasoningEffort: string | undefined;
const fakeStructuredOpenAi = {
	chat: {
		completions: {
			create: async (request: { reasoning_effort?: string }) => {
				requestedReasoningEffort = request.reasoning_effort;
				return {
					choices: [
						{
							finish_reason: "stop",
							message: { content: storyWithCurlyDialogue },
						},
					],
				};
			},
		},
	},
} as never;
const rawStructuredStory = await completeStructuredAi(fakeStructuredOpenAi, []);
assert.equal(requestedReasoningEffort, "none");
assert.doesNotThrow(() => parseReadingStory(rawStructuredStory));
assert.equal(await completeAi(fakeStructuredOpenAi, []), rawStructuredStory);

let translationRequest:
	| {
			model?: string;
			reasoning_effort?: string;
			messages?: ChatMessage[];
	  }
	| undefined;
const fakeTranslationOpenAi = {
	chat: {
		completions: {
			create: async (request: typeof translationRequest) => {
				translationRequest = request;
				return {
					choices: [{ message: { content: '{"vergon":"wand"}' } }],
				};
			},
		},
	},
} as never;
assert.deepEqual(
	await translateWords(
		fakeTranslationOpenAi,
		["vergon"],
		"La sorĉisto uzas vergon por lumsorĉo.",
	),
	{ vergon: "wand" },
);
assert.equal(translationRequest?.model, DEFAULT_TEXT_MODEL);
assert.equal(translationRequest?.reasoning_effort, "none");
assert.match(
	translationRequest?.messages?.[0]?.content ?? "",
	/La sorĉisto uzas vergon por lumsorĉo\./,
);

const emptyOpenAi = {
	chat: {
		completions: {
			create: async () => ({
				id: "completion-empty",
				choices: [
					{
						finish_reason: "length",
						message: { content: "", refusal: null },
					},
				],
				usage: {
					completion_tokens: 4000,
					prompt_tokens: 1000,
					total_tokens: 5000,
				},
			}),
		},
	},
} as never;
await assert.rejects(
	completeStructuredAi(emptyOpenAi, []),
	(error: unknown) => {
		assert(error instanceof AiTraceError);
		const details = error.details;
		assert(
			details !== null &&
				typeof details === "object" &&
				"finishReason" in details,
		);
		assert.equal(details.finishReason, "length");
		return true;
	},
);
console.log("checked reading story: structured completions preserve JSON");

// --- Advancing costs no text generation -------------------------------------

const story: ReadingStory = parsed;
const messagesForPart2 = readingStoryMessages(genre, story, 2);
assert.deepEqual(
	messagesForPart2.filter((message) => message.role === "assistant"),
	[
		{ role: "assistant", content: story.parts[0].text },
		{ role: "assistant", content: story.parts[1].text },
	] satisfies ChatMessage[],
);
console.log("checked reading story: advancing reads prepared parts");

// --- Media is requested once per section ------------------------------------

const voice = "alloy" as NarrationVoiceId;
function section(partIndex: number): ReadingMediaSection {
	return {
		storyId: "kvieta-mateno--1234abcd",
		partIndex,
		partCount: story.parts.length,
		narrationVoice: voice,
		text: story.parts[partIndex - 1].text,
		imagePrompt: readingImagePrompt(story, partIndex),
		genre,
		visualContext: readingVisualContext(story, partIndex),
	};
}

let imageCalls = 0;
let audioCalls = 0;
const media = createReadingMedia({
	generateAudio: async () => {
		audioCalls += 1;
		return null;
	},
	generateBackground: async (): Promise<StoryBackgroundImage> => {
		imageCalls += 1;
		return {
			backgroundImageUrl: "/api/story-images/x/section_3.webp",
			backgroundImageSource: "generated",
		};
	},
});
const [prepared, arrived] = await Promise.all([
	media.prepare(section(3)),
	media.requestBackground(section(3)),
]);
assert.equal(imageCalls, 1);
assert.equal(audioCalls, 1);
assert.equal(
	prepared.backgroundImage?.backgroundImageUrl,
	arrived?.backgroundImageUrl,
);
await media.requestBackground(section(3));
assert.equal(imageCalls, 1);
assert.equal(await media.requestBackground(section(4)), null);
media.seed(section(5), {
	backgroundImage: {
		backgroundImageUrl: "/api/story-images/x/section_5.webp",
		backgroundImageSource: "generated",
	},
});
assert.equal(
	(await media.requestBackground(section(5)))?.backgroundImageUrl,
	"/api/story-images/x/section_5.webp",
);
assert.equal(imageCalls, 1);
// The last part always gets its own image, even when it is even.
assert.equal(
	await media.requestBackground({ ...section(4), partCount: 4 }),
	await media.requestBackground({ ...section(4), partCount: 4 }),
);
assert.equal(imageCalls, 2);
console.log(
	"checked reading media: one provider call per odd section and the last",
);

console.log("\nreading story checks passed");
