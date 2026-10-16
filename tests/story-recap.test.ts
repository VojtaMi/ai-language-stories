import assert from "node:assert/strict";
import { parseStoryRecapLesson } from "../src/storyRecap.ts";
import { splitOnWord } from "../src/structuredGeneration.ts";

/**
 * The recap fill exercise carves a blank out of a natural sentence the model
 * writes. The answer may be a single word or a short collocation like
 * `pensas pri` (the "pensi pri" focus), so these pin the two properties that
 * makes safe: a gap covers a run of whole tokens exactly, and a gap may never
 * swallow more than two words.
 */

// A single-token answer keeps the original surface-form behaviour.
{
	const { before, match, after } = splitOnWord("Mi vidas la domon.", "vidas");
	assert.equal(before, "Mi ");
	assert.equal(match, "vidas");
	assert.equal(after, " la domon.");
}

// A two-word answer is carved out as one contiguous gap.
{
	const { before, match, after } = splitOnWord(
		"Lio pensas pri la akvo.",
		"pensas pri",
	);
	assert.equal(before, "Lio ");
	assert.equal(match, "pensas pri");
	assert.equal(after, " la akvo.");
}

// The answer matches whole tokens only: `pri` must not be found inside `prizorgas`.
assert.throws(() => splitOnWord("Li prizorgas la domon.", "pri"));
console.log("checked recap fill: phrase gap carved on whole-token boundaries");

const recap = (fill: { sentence: string; answer: string; choices: string[] }) =>
	JSON.stringify({
		exercises: [
			{
				pairs: [
					{ term: "pensas pri", meaning: "thinks about" },
					{ term: "kelo", meaning: "basement" },
					{ term: "tempigilo", meaning: "timer" },
				],
			},
			fill,
			{
				question: "What did Lio turn off?",
				answer: "The timer",
				choices: ["The timer", "The red tap"],
			},
		],
	});

// A two-word collocation answer (what Luna produces for a "pensi pri" focus) parses.
{
	const lesson = parseStoryRecapLesson(
		recap({
			sentence: "Lio pensas pri la akvo.",
			answer: "pensas pri",
			choices: ["pensas pri", "iras al", "aŭdas"],
		}),
	);
	assert.equal(lesson.exercises[1].sentenceBeforeBlank, "Lio ");
	assert.equal(lesson.exercises[1].sentenceAfterBlank, " la akvo.");
	assert.equal(lesson.exercises[1].answer, "pensas pri");
}

// A three-word answer is rejected before it can swallow half the sentence.
assert.throws(
	() =>
		parseStoryRecapLesson(
			recap({
				sentence: "Lio pensas pri la akvo.",
				answer: "pensas pri la",
				choices: ["pensas pri la", "iras al la", "aŭdas la"],
			}),
		),
	/at most two words/,
);
console.log("checked recap fill: answer capped at two words");

// A sentence the model pre-cut around one gap gets its answer back.
{
	const lesson = parseStoryRecapLesson(
		recap({
			sentence: "Lina ___ la monujon al la virino.",
			answer: "donas",
			choices: ["donas", "donis", "donos"],
		}),
	);
	assert.equal(lesson.exercises[1].sentenceBeforeBlank, "Lina ");
	assert.equal(
		lesson.exercises[1].sentenceAfterBlank,
		" la monujon al la virino.",
	);
}
// Two gaps are ambiguous and still fail.
assert.throws(() =>
	parseStoryRecapLesson(
		recap({
			sentence: "Lina ___ la ___.",
			answer: "donas",
			choices: ["donas", "donis", "donos"],
		}),
	),
);
console.log("checked recap fill: one pre-cut gap is restored");

console.log("\nstory recap checks passed");
