import assert from "node:assert/strict";
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
	parseReadingVisualPlan,
	READING_STORY_VISUAL_MODEL,
	readingVisualPlanMessages,
} from "../src/reading_story/visualPlan.ts";
import {
	prepareReadingStoryPlot,
	READING_STORY_PLOT_MODEL,
	readingStoryPlotMessages,
	readingStoryPlotReviewMessages,
} from "../src/readingStoryPlot.ts";
import {
	completeAi,
	completeStructuredAi,
	translateWords,
} from "../src/server/aiService.ts";
import { AiTraceError } from "../src/server/aiTrace.ts";
import {
	type ChatMessage,
	type Complete,
	generateReadingStory,
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
};

function finalStoryJson(partCount = 5, imageCount = Math.ceil(partCount / 2)) {
	return JSON.stringify({
		title: manuscript.title,
		storySummary: "Mara finds the correct train.",
		languageFocus: nextStoryBrief.language.focus,
		visualContext:
			"Mara is a woman in her thirties with short black hair and a green coat. The station has stone platforms and a glass roof.",
		properNames: ["Mara"],
		imagePrompts: Array.from(
			{ length: imageCount },
			(_, index) => `Settled scene ${index + 1}.`,
		),
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
const preparedPlot = await prepareReadingStoryPlot(
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
		{ model: READING_STORY_PLOT_MODEL, reasoningEffort: "low" },
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
	/imagePrompts|visualContext/,
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
	/Avoid plurals and direct objects/i,
);
assert.match(
	absoluteBeginnerContext.languageGuidance,
	/Preserve every plot event/i,
);
assert.deepEqual(
	parseReadingManuscript(JSON.stringify(manuscript)),
	manuscript,
);
assert.throws(() => parseReadingManuscript('{"title":"Only a title"}'));

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

// --- Shared visual core and per-pair instructions ----------------------------

const visualMessages = readingVisualPlanMessages(parts);
assert.match(visualMessages[0].content, /Shared visual context/i);
assert.match(visualMessages[0].content, /exactly 2 imagePrompts/i);
assert.match(
	visualMessages[0].content,
	/one imagePrompt for each imageSection/i,
);
assert.match(visualMessages[0].content, /every visible person.*individually/i);
assert.match(visualMessages[0].content, /never use a collective/i);
assert.match(
	visualMessages[0].content,
	/No other people or creatures are visible/,
);
const visualContext = JSON.parse(
	visualMessages[1].content.split("\n\n").at(-1) ?? "",
);
assert.equal(visualContext.imageSections.length, 2);
assert.deepEqual(Object.keys(visualContext), ["imageSections"]);
assert.deepEqual(
	visualContext.imageSections.map(
		(section: { number: number; sourceParts: number[] }) => ({
			number: section.number,
			sourceParts: section.sourceParts,
		}),
	),
	[
		{ number: 1, sourceParts: [1, 2] },
		{ number: 2, sourceParts: [3] },
	],
);
assert.equal(
	visualContext.imageSections[0].text,
	`${parts[0].text}\n\n${parts[1].text}`,
);
assert.deepEqual(buildReadingImageSections([parts[0]]), [
	{ number: 1, sourceParts: [1], text: parts[0].text },
]);

const visualPlan = parseReadingVisualPlan(
	JSON.stringify({
		visualContext: "Stable people and station.",
		properNames: ["Mara"],
		imagePrompts: ["Mara checks the map.", "Mara enters the train."],
	}),
	2,
);
assert.equal(visualPlan.imagePrompts.length, 2);
assert.throws(() =>
	parseReadingVisualPlan(
		JSON.stringify({
			...visualPlan,
			imagePrompts: ["Only one."],
		}),
		2,
	),
);

const visualRepairCalls: ChatMessage[][] = [];
const repairedVisualPlan = await generateReadingVisualPlan(async (messages) => {
	visualRepairCalls.push(messages);
	if (visualRepairCalls.length === 1) {
		return JSON.stringify({
			visualContext: "Stable people and station.",
			properNames: ["Mara"],
			imagePrompts: ["One.", "Two.", "Three."],
		});
	}
	return JSON.stringify({
		visualContext: "Stable people and station.",
		properNames: ["Mara"],
		imagePrompts: ["Parts one and two.", "Part three."],
	});
}, parts);
assert.deepEqual(repairedVisualPlan.imagePrompts, [
	"Parts one and two.",
	"Part three.",
]);
assert.equal(visualRepairCalls.length, 2);
assert.match(
	visualRepairCalls[1][0].content,
	/do not obtain the required count by merely truncating/i,
);
const visualRepairContext = JSON.parse(
	visualRepairCalls[1][1].content.split("\n\n").at(-1) ?? "",
);
assert.equal(visualRepairContext.imageSections.length, 2);
assert.match(
	visualRepairContext.validationFailure,
	/returned 3.*expected exactly 2/i,
);
console.log("checked reading story: visual planning follows settled parts");

// --- Thin orchestration ------------------------------------------------------

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
		if (system.includes("proofreader")) {
			assert.equal(
				JSON.parse(messages[1]?.content ?? "{}").text,
				manuscript.text,
			);
			return '{"corrections":[]}';
		}
		if (system.includes("presentation parts")) {
			return '{"breakAfterSentence":[4,8]}';
		}
		if (system.includes("coherent visual plan")) {
			return JSON.stringify({
				visualContext: "Stable people and station.",
				properNames: ["Mara"],
				imagePrompts: ["Mara checks the map.", "Mara enters the train."],
			});
		}
		throw new Error(`Unexpected pipeline call: ${system.slice(0, 80)}`);
	},
	genre,
	preferences,
	undefined,
	{ nextStoryBrief, reasoningEffort: "medium" },
);
assert.equal(generated.parts.length, 3);
assert.equal(generated.imagePrompts.length, 2);
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
		{ model: READING_STORY_PLOT_MODEL, reasoningEffort: "low" },
		{ reasoningEffort: "medium" },
		{ model: READING_STORY_PROOFREAD_MODEL, reasoningEffort: "medium" },
		{ model: DEFAULT_TEXT_MODEL },
		{ model: READING_STORY_VISUAL_MODEL, reasoningEffort: "none" },
	],
);
console.log("checked reading story: staged pipeline has six explicit calls");

// --- Proofreading --------------------------------------------------------------

const proofreadSource =
	"Marco prope est. Livia dicit: Marco, veni. Una sacculus est. Una sacculus est.";
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
					original: "Livia dicit: Marco, veni.",
					corrected:
						"Livia, quae in statione diu exspectat, Marcum magna voce vocat et dicit: Marce, veni celeriter ad me.",
				},
				// Not in the text at all.
				{ original: "Tramen venit.", corrected: "Tramen venit!" },
				{ original: "Marcus", reason: "missing corrected field" },
			],
		}),
	),
);
assert.equal(
	proofread.text,
	"Marcus prope est. Livia dicit: Marco, veni. Una sacculus est. Una sacculus est.",
);
assert.equal(proofread.applied.length, 1);

const failedProofread = await generateReadingStory(
	async (messages) => {
		const system = messages[0]?.content ?? "";
		if (system.includes("Prepare a short story plot")) return "A plot.";
		if (system.includes("reviewing a short story draft")) return "OK";
		if (system.includes("finished manuscript"))
			return JSON.stringify(manuscript);
		if (system.includes("proofreader")) throw new Error("provider down");
		if (system.includes("presentation parts")) {
			return '{"breakAfterSentence":[4,8]}';
		}
		return JSON.stringify({
			visualContext: "Stable people and station.",
			properNames: ["Mara"],
			imagePrompts: ["Mara checks the map.", "Mara enters the train."],
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

// --- Final story validation and dynamic media cadence ------------------------

const parsed = parseReadingStory(finalStoryJson(5));
assert.equal(parsed.parts.length, 5);
assert.equal(parsed.imagePrompts.length, 3);
assert.equal(readingImagePrompt(parsed, 1), parsed.imagePrompts[0]);
assert.equal(readingImagePrompt(parsed, 2), parsed.imagePrompts[0]);
assert.equal(readingImagePrompt(parsed, 3), parsed.imagePrompts[1]);
assert.equal(readingImagePrompt(parsed, 5), parsed.imagePrompts[2]);
assert.equal(readingVisualContext(parsed), parsed.visualContext);
assert.throws(() => parseReadingStory(finalStoryJson(5, 2)));
assert.throws(() => parseReadingStory(finalStoryJson(9)));
assert.throws(() =>
	parseReadingStory(
		finalStoryJson(3).replace('"visualContext":', '"missingVisualContext":'),
	),
);
assert.deepEqual(
	parseReadingStory(
		`Here is the story:\n\`\`\`json\n${finalStoryJson(5)}\n\`\`\``,
	),
	parsed,
);
assert.deepEqual(parseReadingStory(`${finalStoryJson(5)}}`), parsed);
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
		narrationVoice: voice,
		text: story.parts[partIndex - 1].text,
		imagePrompt: readingImagePrompt(story, partIndex),
		genre,
		visualContext: readingVisualContext(story),
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
console.log("checked reading media: one provider call per odd section");

console.log("\nreading story checks passed");
