import { DEFAULT_LANGUAGE, type Language } from "./languages";
import {
	countWords,
	type GenerationSpec,
	isObject,
	parseChoices,
	requiredString,
	splitOnWord,
} from "./structuredGeneration";

export interface StoryRecapWordConnectExercise {
	id: string;
	type: "word-connect";
	title: string;
	hint: string;
	pairs: Array<{
		term: string;
		meaning: string;
	}>;
}

export interface StoryRecapFillMissingWordExercise {
	id: string;
	type: "fill-missing-word";
	title: string;
	hint: string;
	sentenceBeforeBlank: string;
	sentenceAfterBlank: string;
	answer: string;
	choices: string[];
}

export interface StoryRecapQuestionExercise {
	id: string;
	type: "story-question";
	title: string;
	hint: string;
	question: string;
	answer: string;
	choices: string[];
}

export type StoryRecapExercise =
	| StoryRecapWordConnectExercise
	| StoryRecapFillMissingWordExercise
	| StoryRecapQuestionExercise;

export interface StoryRecapLesson {
	id: string;
	title: string;
	exercises: [
		StoryRecapWordConnectExercise,
		StoryRecapFillMissingWordExercise,
		StoryRecapQuestionExercise,
	];
}

export interface StoryRecapExerciseResult {
	id: string;
	type: StoryRecapExercise["type"];
	label: string;
	attempts: number;
}

/**
 * Each exercise type owns the slice of the generation prompt it needs (its
 * JSON shape and authoring rules) and how to parse its own response, so
 * adding a new recap exercise type means adding one spec here rather than
 * editing a shared prompt string and a shared parser.
 */
type RecapExerciseSpec<T> = GenerationSpec<T>;

function wordConnectSpec(
	genre: Language,
): RecapExerciseSpec<StoryRecapWordConnectExercise> {
	return {
		shape: {
			pairs: [{ term: `${genre.label} word`, meaning: "English meaning" }],
		},
		instructions:
			"Use exactly three word-connect pairs, using only words and facts from the story. Keep English meanings short. " +
			"When the learner looked up words while reading, build the pairs from those words first, in their story forms, and fill any remaining pairs with other useful story words.",
		parse(value) {
			if (
				!isObject(value) ||
				!Array.isArray(value.pairs) ||
				value.pairs.length !== 3
			) {
				throw new Error("Recap word-connect exercise needs three pairs.");
			}
			return {
				id: "word-connect",
				type: "word-connect",
				title: "Connect the words",
				hint: "Select a word, then its meaning.",
				pairs: value.pairs.map((pair) => {
					if (!isObject(pair)) throw new Error("Recap word pair is invalid.");
					return {
						term: requiredString(pair.term, "word term", "Recap JSON"),
						meaning: requiredString(pair.meaning, "word meaning", "Recap JSON"),
					};
				}),
			};
		},
	};
}

function fillMissingWordSpec(
	genre: Language,
): RecapExerciseSpec<StoryRecapFillMissingWordExercise> {
	return {
		shape: {
			sentence: `A complete, natural ${genre.label} sentence that contains the answer word`,
			answer: `correct ${genre.label} word, exactly as it appears in sentence`,
			choices: ["correct", "wrong", "wrong"],
		},
		instructions:
			"Use exactly three fill choices, using only words from the story. " +
			"This exercise is the story's focus test: it must exercise the story's primary language focus stated below. " +
			"Exactly one choice may complete the sentence; each wrong choice must be impossible in its place because of the focus, never merely a different true fact from the story. " +
			"For a grammar focus, make the choices forms of the same word or phrase that differ only in the focus feature, such as the article, ending, case, or tense (for example den Käse | der Käse | dem Käse), so the sentence alone decides the answer without recalling the story's exact wording. " +
			"When the choices differ in tense, the sentence must contain a time expression that allows only the answer's tense, such as yesterday or tomorrow in the story's language; words like then, afterwards, or in the evening do not decide tense, so add a deciding one to the story's sentence when needed. " +
			"Every choice must be a real, correctly spelled form of the word: keep the stem exactly as in the answer and change only the tested part. " +
			`Choose the fill sentence so its blanked \`answer\` is the exact ${genre.label} word or short phrase that realizes that focus. ` +
			"The `answer` is a single word or at most a short two-word phrase. " +
			`The fill sentence must be one complete, natural ${genre.label} sentence containing the answer written exactly as in \`answer\` — the app carves the blank out of it itself, so write a normal sentence and do not pre-split it or omit the answer.`,
		parse(value) {
			if (!isObject(value)) throw new Error("Recap fill exercise is invalid.");
			const answer = requiredString(value.answer, "fill answer", "Recap JSON");
			if (countWords(answer) > 2) {
				throw new Error("Recap fill answer must be at most two words.");
			}
			const written = requiredString(
				value.sentence,
				"fill sentence",
				"Recap JSON",
			);
			// Models sometimes pre-cut the gap despite the instructions; one
			// unambiguous gap is restored rather than failing the whole recap.
			const gaps = written.match(/_{2,}/g) ?? [];
			const sentence =
				gaps.length === 1 ? written.replace(/_{2,}/, answer) : written;
			const { before, after } = splitOnWord(
				sentence,
				answer,
				"Recap fill sentence does not contain the answer word.",
			);
			return {
				id: "fill-missing-word",
				type: "fill-missing-word",
				title: "Fill the missing word",
				hint: "Choose the word that completes the sentence.",
				sentenceBeforeBlank: before,
				sentenceAfterBlank: after,
				answer,
				choices: parseChoices(
					value.choices,
					answer,
					3,
					3,
					"Recap choices do not include the answer.",
					"Recap JSON",
				),
			};
		},
	};
}

const storyQuestionSpec: RecapExerciseSpec<StoryRecapQuestionExercise> = {
	shape: {
		question: "Simple English question about the story",
		answer: "correct answer",
		choices: ["correct", "wrong"],
	},
	instructions:
		"Use two or three story-question choices, using only facts from the story. Exactly one choice is true according to the story; every other choice must be clearly false in the story.",
	parse(value) {
		if (!isObject(value)) throw new Error("Recap story question is invalid.");
		const answer = requiredString(
			value.answer,
			"story question answer",
			"Recap JSON",
		);
		return {
			id: "story-question",
			type: "story-question",
			title: "Story question",
			hint: "Choose the answer that fits the story.",
			question: requiredString(value.question, "story question", "Recap JSON"),
			answer,
			choices: parseChoices(
				value.choices,
				answer,
				2,
				3,
				"Recap choices do not include the answer.",
				"Recap JSON",
			),
		};
	},
};

function recapExerciseSpecs(genre: Language) {
	return [
		wordConnectSpec(genre),
		fillMissingWordSpec(genre),
		storyQuestionSpec,
	];
}

/**
 * The fill-missing-word exercise is the deterministic focus test: it is always
 * the exercise that probes the story's primary language focus, so a finished
 * story yields a clean pass/fail on the exact concept. The blank itself is still
 * derived in code (see {@link fillMissingWordSpec} and `splitOnWord`); only the
 * choice of the focus-realizing sentence needs the model.
 */
export const RECAP_FOCUS_EXERCISE_TYPE = "fill-missing-word" as const;

/** Composes the recap generation prompt from each exercise type's own shape and rules. */
export function buildStoryRecapPrompt(
	primaryFocus?: string,
	genre: Language = DEFAULT_LANGUAGE,
): string {
	const specs = recapExerciseSpecs(genre);
	const shape = JSON.stringify({
		exercises: specs.map((spec) => spec.shape),
	});
	const instructions = specs.map((spec) => spec.instructions).join(" ");
	const focus = primaryFocus?.trim();
	return (
		`Create a tiny end-of-story ${genre.label} recap lesson for a beginner. ` +
		"Return only valid JSON with this exact shape: " +
		`${shape} ` +
		`${instructions} ` +
		(focus ? `Story's primary language focus: "${focus}". ` : "") +
		"Do not include markdown, comments, explanations, trailing commas, or extra fields."
	);
}

export function parseStoryRecapLesson(
	text: string,
	genre: Language = DEFAULT_LANGUAGE,
): StoryRecapLesson {
	const parsed = JSON.parse(text) as unknown;
	if (!isObject(parsed)) throw new Error("Recap JSON was not an object.");
	if (!Array.isArray(parsed.exercises)) {
		throw new Error("Recap JSON is missing exercises.");
	}
	return {
		id: `story-recap-${Date.now()}`,
		title: genre.recapTitle,
		exercises: [
			wordConnectSpec(genre).parse(parsed.exercises[0]),
			fillMissingWordSpec(genre).parse(parsed.exercises[1]),
			storyQuestionSpec.parse(parsed.exercises[2]),
		],
	};
}
