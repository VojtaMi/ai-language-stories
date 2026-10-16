import assert from "node:assert/strict";
import { askLanguageTutor } from "../src/ai.ts";
import {
	getLanguage,
	languageBotImageUrl,
	languageFaviconUrl,
	languageHeroImageUrl,
	languageSelectionLabel,
	languages,
	languageTtsInstructions,
	starterBriefForLanguage,
} from "../src/languages.ts";
import {
	DEFAULT_STORY_MEMORY,
	mergeStoryMemory,
	type RecentStoryMemory,
} from "../src/learnerState.ts";
import { STARTER_NEXT_STORY_BRIEF } from "../src/nextStoryBrief.ts";
import { readingManuscriptMessages } from "../src/reading_story/manuscript.ts";
import { createBundleId } from "../src/server/storyBundleStore.ts";
import { buildStoryRecapPrompt } from "../src/storyRecap.ts";
import { isStoryName, storyWords } from "../src/storyVocabulary.ts";

assert.equal(
	new Set(languages.map((language) => language.id)).size,
	languages.length,
);
assert.equal(
	new Set(languages.map(languageHeroImageUrl)).size,
	languages.length,
);
assert.equal(
	new Set(languages.map(languageBotImageUrl)).size,
	languages.length,
);
assert.equal(new Set(languages.map(languageFaviconUrl)).size, languages.length);

const germanStoryId = createBundleId(
	"german",
	"Der kleine Schlüssel",
	"ABCDEF12-0000",
);
assert.equal(germanStoryId, "german--der-kleine-schlussel--abcdef12");
const german = getLanguage("german");
const germanStarterBrief = starterBriefForLanguage(german);
const germanPrompt = readingManuscriptMessages(
	german,
	"A person finds a key and returns it.",
	germanStarterBrief,
)[0].content;
assert.match(germanPrompt, /beginner German reading story/);
assert.match(germanPrompt, /capitalize every noun/i);
assert.match(germanPrompt, /verb-second/i);

const spanish = getLanguage("spanish");
const spanishRecap = buildStoryRecapPrompt("present-tense actions", spanish);
assert.match(spanishRecap, /Spanish recap lesson/);
assert.match(spanishRecap, /Exactly one choice may complete the sentence/);
assert.match(spanishRecap, /differ only in the focus feature/);
assert.match(
	spanishRecap,
	/time expression that allows only the answer's tense/,
);
assert.match(spanishRecap, /every other choice must be clearly false/);
assert.equal(spanish.recapTitle, "Práctica breve");

const dutch = getLanguage("dutch");
const dutchStarterBrief = starterBriefForLanguage(dutch);
const dutchPrompt = readingManuscriptMessages(
	dutch,
	"A person finds a key and returns it.",
	dutchStarterBrief,
)[0].content;
assert.match(dutchPrompt, /beginner Dutch reading story/);
assert.match(dutchPrompt, /de, het, and een/i);
assert.match(dutchPrompt, /verb-second/i);
const dutchRecap = buildStoryRecapPrompt("present-tense actions", dutch);
assert.match(dutchRecap, /Dutch recap lesson/);
assert.equal(dutch.recapTitle, "Kleine oefening");
assert.match(
	dutchStarterBrief.language.calibrationSnippets[0] ?? "",
	/een tuin/,
);

const finnish = getLanguage("finnish");
const finnishStarterBrief = starterBriefForLanguage(finnish);
const finnishPrompt = readingManuscriptMessages(
	finnish,
	"A person finds a key and returns it.",
	finnishStarterBrief,
)[0].content;
assert.match(finnishPrompt, /beginner Finnish reading story/);
assert.match(finnishPrompt, /articles or grammatical gender/i);
assert.match(finnishPrompt, /vowel harmony/i);
const finnishRecap = buildStoryRecapPrompt("present-tense actions", finnish);
assert.match(finnishRecap, /Finnish recap lesson/);
assert.equal(finnish.recapTitle, "Pieni harjoitus");
assert.match(
	finnishStarterBrief.language.calibrationSnippets[0] ?? "",
	/puutarhassa/,
);

const latin = getLanguage("latin");
const latinPrompt = readingManuscriptMessages(
	latin,
	"Julia sits in a garden while Marcus sings.",
	starterBriefForLanguage(latin),
)[0].content;
assert.match(latinPrompt, /beginner Latin reading story/);
assert.match(latinPrompt, /Never simplify by dropping case endings/);
assert.match(latinPrompt, /ablative for location/);
assert.match(latinPrompt, /accusative for motion into/);
assert.match(latinPrompt, /Decline Latin personal names correctly/);

const ecclesiastical = getLanguage("latin-ecclesiastical");
assert.equal(latin.label, "Latin");
assert.equal(ecclesiastical.label, "Latin");
assert.equal(languageSelectionLabel(latin), "Latin - Classical");
assert.equal(languageSelectionLabel(ecclesiastical), "Latin - Ecclesiastical");
assert.deepEqual(
	starterBriefForLanguage(ecclesiastical),
	starterBriefForLanguage(latin),
);
assert.equal(ecclesiastical.grammarInvariants, latin.grammarInvariants);
assert.match(languageTtsInstructions(latin), /restored Classical Latin/);
assert.match(
	languageTtsInstructions(getLanguage("esperanto")),
	/^The transcript is Esperanto\..*never translate.*kaj is one syllable/,
);
assert.match(languageTtsInstructions(latin), /Consonantal v is \[w\]/);
assert.match(languageTtsInstructions(latin), /c is always \[k\]/);
assert.match(
	languageTtsInstructions(ecclesiastical),
	/Roman Ecclesiastical Latin/,
);
assert.match(languageTtsInstructions(ecclesiastical), /Consonantal v is \[v\]/);
assert.match(languageTtsInstructions(ecclesiastical), /\[tʃ\]/);
assert.notEqual(
	createBundleId(latin.id, "Test story", "ABCDEF12"),
	createBundleId(ecclesiastical.id, "Test story", "ABCDEF12"),
);

const originalFetch = globalThis.fetch;
try {
	for (const language of [latin, ecclesiastical]) {
		globalThis.fetch = async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			assert.ok(
				body.messages[0].content.includes(language.pronunciationGuidance),
			);
			return Response.json({ text: "Pronunciation explanation." });
		};
		await askLanguageTutor({
			language,
			segments: [],
			currentTarget: null,
			conversation: [],
			question: "How do I pronounce Cicero?",
		});
	}
} finally {
	globalThis.fetch = originalFetch;
}

assert.equal(isStoryName("Petron", ["Petro"], "esperanto"), true);
assert.equal(isStoryName("Petron", ["Petro"], "german"), false);
assert.deepEqual(storyWords(["Petro vidas Petron."], ["Petro"], "esperanto"), [
	"vidas",
]);
assert.deepEqual(storyWords(["Petro sieht Petron."], ["Petro"], "german"), [
	"sieht",
	"petron",
]);

function memory(
	genreId: RecentStoryMemory["genreId"],
	index: number,
): RecentStoryMemory {
	return {
		genreId,
		motif: `${genreId} motif ${index}`,
		protagonist: "learner",
		setting: "room",
		elements: [`object ${index}`],
	};
}

let storyMemory = structuredClone(DEFAULT_STORY_MEMORY);
for (let index = 0; index < 6; index += 1) {
	storyMemory = mergeStoryMemory(
		storyMemory,
		memory("esperanto", index),
		"2026-08-20",
	);
}
storyMemory = mergeStoryMemory(storyMemory, memory("german", 0), "2026-08-20");
assert.equal(
	storyMemory.recentStories.filter((story) => story.genreId === "esperanto")
		.length,
	5,
);
assert.equal(
	storyMemory.recentStories.filter((story) => story.genreId === "german")
		.length,
	1,
);
assert.notDeepEqual(germanStarterBrief, STARTER_NEXT_STORY_BRIEF);

console.log("language registry and isolation checks passed");
