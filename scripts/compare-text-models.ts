/** Compare OpenAI text models on the production reading-manuscript task. */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import {
	getLanguage,
	isLanguageId,
	type Language,
	type LanguageId,
	languages,
	starterBriefForLanguage,
} from "../src/languages.ts";
import type { LearnerPreferences } from "../src/learnerState.ts";
import {
	READING_STORY_MAX_TOKENS,
	TEXT_MODELS,
	TEXT_REASONING_EFFORTS,
	type TextModelId,
	type TextReasoningEffort,
} from "../src/models.ts";
import type { NextStoryBrief } from "../src/nextStoryBrief.ts";
import {
	parseReadingManuscript,
	type ReadingStoryManuscript,
	readingManuscriptMessages,
} from "../src/reading_story/manuscript.ts";

const PRICING_CHECKED_AT = "2026-09-22";
const DEFAULT_JUDGE_MODEL = "gpt-6-astra";
const DEFAULT_REPEATS = 2;

const OPENAI_PRICING = {
	"gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
	"gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
	"gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
	"gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
	"gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10 },
	"gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
} as const;

export type EvalModelId = keyof typeof OPENAI_PRICING;

export type EvalCandidate = {
	id: string;
	model: EvalModelId;
	reasoningEffort: TextReasoningEffort;
};

type Usage = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
};

type FixtureId = (typeof FIXTURES)[number]["id"];

type EvaluationCase = {
	id: string;
	fixtureId: FixtureId;
	languageId: LanguageId;
	storyPlot: string;
	brief: NextStoryBrief;
	preferences: Pick<LearnerPreferences, "prefer" | "avoid">;
	expectedNames: string[];
};

export type GenerationRecord = {
	id: string;
	kind: "generation";
	caseId: string;
	fixtureId: FixtureId;
	languageId: LanguageId;
	candidateId: string;
	model: EvalModelId;
	reasoningEffort: TextReasoningEffort;
	repeatIndex: number;
	latencyMs: number;
	finishReason: string | null;
	usage: Usage;
	estimatedCostUsd: number;
	rawOutput: string;
	manuscript?: ReadingStoryManuscript;
	validationError?: string;
	requestError?: string;
};

export type DeterministicScore = {
	score: number;
	checks: {
		validManuscript: number;
		titleLength: number;
		wordCount: number;
		sentenceCount: number;
		noMarkup: number;
		nameCoverage: number;
		noExactSentenceRepeat: number;
	};
	notes: string[];
};

export type JudgeScore = {
	grammarAndNaturalness: number;
	beginnerSuitability: number;
	languageFocusAdherence: number;
	plotFidelity: number;
	engagement: number;
	preferenceAdherence: number;
	needsEditing: boolean;
	seriousErrors: string[];
	notes: string;
};

type JudgmentRecord = {
	id: string;
	kind: "judgment";
	generationId: string;
	judgeModel: string;
	latencyMs: number;
	usage: Usage;
	estimatedCostUsd: number;
	score?: JudgeScore;
	error?: string;
};

type CandidateScore = {
	generationId: string;
	caseId: string;
	fixtureId: FixtureId;
	languageId: LanguageId;
	candidateId: string;
	model: EvalModelId;
	reasoningEffort: TextReasoningEffort;
	repeatIndex: number;
	deterministic: DeterministicScore;
	judge: JudgeScore | null;
	qualityScore: number;
	latencyMs: number;
	estimatedCostUsd: number;
	valid: boolean;
};

type ModelSummary = {
	candidateId: string;
	model: EvalModelId;
	reasoningEffort: TextReasoningEffort;
	runs: number;
	validRate: number;
	averageQuality: number;
	averageDeterministic: number;
	averageJudge: number | null;
	needsEditingRate: number | null;
	averageCostUsd: number;
	totalCostUsd: number;
	medianLatencyMs: number;
	p95LatencyMs: number;
	versusBaseline?: { wins: number; ties: number; losses: number };
};

export type ModelComparisonOptions = {
	candidates: EvalCandidate[];
	dryRun: boolean;
	fixtureIds: FixtureId[];
	help: boolean;
	judge: boolean;
	judgeModel: string;
	languageIds: LanguageId[];
	outputDir: string;
	repeats: number;
	smoke: boolean;
};

const FIXTURES = [
	{
		id: "station-key",
		brief: "starter",
		storyPlot:
			"Lina arrives at a quiet train station and finds a small key on a bench. She asks Marko, the station worker, for help. Marko recognizes the key as belonging to Ana, who works in the station cafe. Lina returns the key to Ana. Ana thanks Lina, and Lina boards her arriving train.",
		expectedNames: ["Lina", "Marko", "Ana"],
		preferences: {
			prefer: ["warm, realistic stories with a small practical problem"],
			avoid: ["magic", "overly childish stories"],
		},
	},
	{
		id: "garden-telescope",
		brief: "reinforce",
		storyPlot:
			"Mira and Leo meet in a community garden after sunset to share a telescope. While they take turns looking at the moon, they notice a lantern beside the tool shed. Next to it lies a rake that their neighbor Oskar has been seeking. They return the rake, then Oskar joins them to look through the telescope.",
		expectedNames: ["Mira", "Leo", "Oskar"],
		preferences: {
			prefer: ["quiet mysteries", "recurring concrete vocabulary"],
			avoid: ["danger", "supernatural explanations"],
		},
	},
	{
		id: "storm-shops",
		brief: "advance",
		storyPlot:
			"Baker Sara sees rainwater moving toward her bakery and Niko's neighboring bookshop. Sara and Niko move boxes onto shelves and place sandbags by both doors. They hear tapping behind the shops and find a loose sign holding wet leaves over a drain. Niko holds the sign aside while Sara clears the leaves. The water drains away, and they share bread and tea after the storm.",
		expectedNames: ["Sara", "Niko"],
		preferences: {
			prefer: ["cooperative adults", "problems solved through observation"],
			avoid: ["villains", "overly childish stories"],
		},
	},
] as const;

const DEFAULT_CANDIDATES = [
	"gpt-5.6-luna:low",
	"gpt-6-luna:low",
	"gpt-6-sol:low",
];

const HELP = `Usage: npm run model:compare -- [options]

Compare OpenAI models on the exact production reading-manuscript prompt.

Options:
  --candidates <list>  Comma-separated model:effort pairs
  --languages <list>   Comma-separated language ids (default: all)
  --fixtures <list>    ${FIXTURES.map(({ id }) => id).join("|")} (default: all)
  --repeats <n>        Runs per candidate and case (default: ${DEFAULT_REPEATS})
  --judge-model <id>   Blinded quality judge (default: ${DEFAULT_JUDGE_MODEL})
  --no-judge           Skip model grading; keep deterministic scores
  --output <path>      Artifact directory; an existing directory resumes a run
  --smoke              One Esperanto fixture, one repeat, all default candidates
  --dry-run            Validate and write the manifest without API calls
  --help               Show this help

Artifacts: manifest.json, runs.jsonl, judgments.jsonl, scores.json, summary.md,
blind-review.md, and blind-key.json.
`;

const ENGLISH_WORDS = [
	"the",
	"and",
	"because",
	"story",
	"chapter",
	"then",
	"outside",
	"inside",
];

const MARKUP_PATTERNS = [/^#+\s/m, /```/, /\*\*/, /^section\s+\d/im];

export function parseTextModelComparisonArgs(
	rawArgs: string[],
	now = new Date(),
): ModelComparisonOptions {
	let rawCandidates: string | undefined;
	let rawLanguages: string | undefined;
	let rawFixtures: string | undefined;
	let outputDir: string | undefined;
	let judgeModel = DEFAULT_JUDGE_MODEL;
	let repeats = DEFAULT_REPEATS;
	let judge = true;
	let dryRun = false;
	let smoke = false;
	let help = false;

	for (let index = 0; index < rawArgs.length; index += 1) {
		const argument = rawArgs[index];
		switch (argument) {
			case "--help":
				help = true;
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--smoke":
				smoke = true;
				break;
			case "--no-judge":
				judge = false;
				break;
			case "--candidates":
				rawCandidates = flagValue(rawArgs, index, argument);
				index += 1;
				break;
			case "--languages":
				rawLanguages = flagValue(rawArgs, index, argument);
				index += 1;
				break;
			case "--fixtures":
				rawFixtures = flagValue(rawArgs, index, argument);
				index += 1;
				break;
			case "--judge-model":
				judgeModel = flagValue(rawArgs, index, argument);
				index += 1;
				break;
			case "--output":
				outputDir = resolve(flagValue(rawArgs, index, argument));
				index += 1;
				break;
			case "--repeats": {
				const value = Number(flagValue(rawArgs, index, argument));
				if (!Number.isSafeInteger(value) || value < 1) {
					throw new Error("--repeats must be a positive integer.");
				}
				repeats = value;
				index += 1;
				break;
			}
			default:
				throw new Error(
					`Unknown argument "${argument}". Use --help for usage.`,
				);
		}
	}

	const runId = now.toISOString().replace(/[:.]/g, "-");
	const languageIds = smoke
		? (["esperanto"] satisfies LanguageId[])
		: parseLanguageIds(rawLanguages);
	const fixtureIds = smoke
		? (["station-key"] satisfies FixtureId[])
		: parseFixtureIds(rawFixtures);

	return {
		candidates: parseCandidates(rawCandidates),
		dryRun,
		fixtureIds,
		help,
		judge,
		judgeModel,
		languageIds,
		outputDir: outputDir ?? resolve(".artifacts", "model-comparison", runId),
		repeats: smoke ? 1 : repeats,
		smoke,
	};
}

function flagValue(rawArgs: string[], index: number, flag: string) {
	const value = rawArgs[index + 1]?.trim();
	if (!value || value.startsWith("--"))
		throw new Error(`${flag} requires a value.`);
	return value;
}

function parseCandidates(raw?: string): EvalCandidate[] {
	const modelIds = new Set(TEXT_MODELS.map(({ id }) => id));
	const values = raw ? splitList(raw) : DEFAULT_CANDIDATES;
	const candidates = values.map((value) => {
		const separator = value.lastIndexOf(":");
		const model = value.slice(0, separator) as EvalModelId;
		const reasoningEffort = value.slice(separator + 1) as TextReasoningEffort;
		if (separator < 1 || !modelIds.has(model as TextModelId)) {
			throw new Error(`Unknown candidate model in "${value}".`);
		}
		if (!(model in OPENAI_PRICING) || model === DEFAULT_JUDGE_MODEL) {
			throw new Error(
				`Model "${model}" is not supported as an evaluation candidate.`,
			);
		}
		if (!TEXT_REASONING_EFFORTS.includes(reasoningEffort)) {
			throw new Error(`Unknown reasoning effort in "${value}".`);
		}
		return { id: `${model}:${reasoningEffort}`, model, reasoningEffort };
	});
	if (new Set(candidates.map(({ id }) => id)).size !== candidates.length) {
		throw new Error("Candidate list contains duplicates.");
	}
	return candidates;
}

function parseLanguageIds(raw?: string): LanguageId[] {
	const ids = raw ? splitList(raw) : languages.map(({ id }) => id);
	for (const id of ids) {
		if (!isLanguageId(id)) throw new Error(`Unknown language "${id}".`);
	}
	return ids as LanguageId[];
}

function parseFixtureIds(raw?: string): FixtureId[] {
	const ids = raw ? splitList(raw) : FIXTURES.map(({ id }) => id);
	for (const id of ids) {
		if (!FIXTURES.some((fixture) => fixture.id === id)) {
			throw new Error(`Unknown fixture "${id}".`);
		}
	}
	return ids as FixtureId[];
}

function splitList(value: string) {
	const items = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	if (items.length === 0)
		throw new Error("Expected a non-empty comma-separated list.");
	return items;
}

export function buildEvaluationCases(
	languageIds: LanguageId[],
	fixtureIds: FixtureId[],
): EvaluationCase[] {
	return languageIds.flatMap((languageId) => {
		const language = getLanguage(languageId);
		return fixtureIds.map((fixtureId) => {
			const fixture = FIXTURES.find((candidate) => candidate.id === fixtureId);
			if (!fixture) throw new Error(`Unknown fixture "${fixtureId}".`);
			return {
				id: `${languageId}__${fixture.id}`,
				fixtureId: fixture.id,
				languageId,
				storyPlot: fixture.storyPlot,
				brief: briefForFixture(language, fixture.brief),
				preferences: {
					prefer: [...fixture.preferences.prefer],
					avoid: [...fixture.preferences.avoid],
				},
				expectedNames: [...fixture.expectedNames],
			};
		});
	});
}

function briefForFixture(
	language: Language,
	type: (typeof FIXTURES)[number]["brief"],
): NextStoryBrief {
	const starter = starterBriefForLanguage(language);
	if (type === "starter") return starter;
	return {
		themeSuggestion: "",
		narrativeScale: "simple",
		language: {
			focus:
				type === "reinforce"
					? `Use simple present-tense action verbs and concrete location expressions. Reinforce this foundation: ${language.starterFocus}`
					: `Use clear location and movement expressions while advancing modestly from this foundation: ${language.starterFocus}`,
			progression: type,
			complexity: type === "reinforce" ? "similar" : "harder",
			calibrationSnippets: [...language.calibrationSnippets],
		},
	};
}

export function scoreManuscriptDeterministically(
	record: Pick<
		GenerationRecord,
		"manuscript" | "validationError" | "requestError"
	>,
	evaluationCase: Pick<EvaluationCase, "brief" | "expectedNames">,
): DeterministicScore {
	const manuscript = record.manuscript;
	if (!manuscript) {
		return {
			score: 0,
			checks: {
				validManuscript: 0,
				titleLength: 0,
				wordCount: 0,
				sentenceCount: 0,
				noMarkup: 0,
				nameCoverage: 0,
				noExactSentenceRepeat: 0,
			},
			notes: [
				record.requestError ?? record.validationError ?? "Missing manuscript.",
			],
		};
	}

	const notes: string[] = [];
	const words = wordTokens(manuscript.text);
	const sentences = splitSentences(manuscript.text);
	const titleWords = wordTokens(manuscript.title).length;
	const minimal = evaluationCase.brief.narrativeScale === "minimal";
	const wordRange = minimal ? [90, 150] : [160, 260];
	const sentenceRange = minimal ? [8, 14] : [12, 22];
	const markupHits = MARKUP_PATTERNS.filter((pattern) =>
		pattern.test(manuscript.text),
	);
	const englishHits = ENGLISH_WORDS.filter((word) =>
		new RegExp(`\\b${word}\\b`, "i").test(manuscript.text),
	);
	const namesFound = evaluationCase.expectedNames.filter((name) =>
		manuscript.text.toLocaleLowerCase().includes(name.toLocaleLowerCase()),
	).length;
	const normalizedSentences = sentences.map(normalizeText);
	const repeatedSentences = normalizedSentences.filter(
		(sentence, index) =>
			sentence && normalizedSentences.indexOf(sentence) !== index,
	);

	if (!inRange(words.length, wordRange))
		notes.push(`Word count ${words.length} is outside ${wordRange.join("-")}.`);
	if (!inRange(sentences.length, sentenceRange))
		notes.push(
			`Sentence count ${sentences.length} is outside ${sentenceRange.join("-")}.`,
		);
	if (markupHits.length)
		notes.push("Markup or a section heading was detected.");
	if (englishHits.length)
		notes.push(`English-looking words: ${englishHits.join(", ")}.`);
	if (namesFound < evaluationCase.expectedNames.length)
		notes.push("One or more plot names are missing.");
	if (repeatedSentences.length) notes.push("An exact sentence was repeated.");

	const checks = {
		validManuscript: 1,
		titleLength: titleWords >= 2 && titleWords <= 6 ? 1 : 0,
		wordCount: rangeScore(words.length, wordRange),
		sentenceCount: rangeScore(sentences.length, sentenceRange),
		noMarkup: markupHits.length === 0 && englishHits.length === 0 ? 1 : 0,
		nameCoverage: namesFound / Math.max(evaluationCase.expectedNames.length, 1),
		noExactSentenceRepeat: repeatedSentences.length === 0 ? 1 : 0,
	};
	return { score: average(Object.values(checks)) * 5, checks, notes };
}

function inRange(value: number, [minimum, maximum]: number[]) {
	return (
		value >= (minimum ?? 0) && value <= (maximum ?? Number.POSITIVE_INFINITY)
	);
}

function rangeScore(value: number, range: number[]) {
	const [minimum = 0, maximum = Number.POSITIVE_INFINITY] = range;
	if (value >= minimum && value <= maximum) return 1;
	const distance = value < minimum ? minimum - value : value - maximum;
	return Math.max(0, 1 - distance / Math.max(maximum - minimum, 1));
}

function wordTokens(text: string) {
	return text.match(/[\p{L}'-]+/gu) ?? [];
}

function splitSentences(text: string) {
	return text
		.split(/[.!?]+(?:["')\]]+)?/u)
		.map((part) => part.trim())
		.filter(Boolean);
}

function normalizeText(text: string) {
	return text
		.toLocaleLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function average(values: number[]) {
	return values.length
		? values.reduce((total, value) => total + value, 0) / values.length
		: 0;
}

function percentile(values: number[], fraction: number) {
	if (!values.length) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

function blankUsage(): Usage {
	return {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
	};
}

function responseUsage(response: ChatCompletion): Usage {
	const usage = response.usage;
	return {
		inputTokens: usage?.prompt_tokens ?? 0,
		cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
		outputTokens: usage?.completion_tokens ?? 0,
		reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
		totalTokens: usage?.total_tokens ?? 0,
	};
}

function estimateCost(model: string, usage: Usage) {
	const price = OPENAI_PRICING[model as EvalModelId];
	if (!price) return 0;
	const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
	return (
		(uncached * price.input +
			usage.cachedInputTokens * price.cachedInput +
			usage.outputTokens * price.output) /
		1_000_000
	);
}

async function generateCandidate(
	openai: OpenAI,
	evaluationCase: EvaluationCase,
	candidate: EvalCandidate,
	repeatIndex: number,
): Promise<GenerationRecord> {
	const id = `${evaluationCase.id}__${candidate.model}_${candidate.reasoningEffort}__r${repeatIndex + 1}`;
	const started = performance.now();
	try {
		const response = await openai.chat.completions.create({
			model: candidate.model,
			max_completion_tokens: READING_STORY_MAX_TOKENS,
			reasoning_effort: candidate.reasoningEffort,
			messages: readingManuscriptMessages(
				getLanguage(evaluationCase.languageId),
				evaluationCase.storyPlot,
				evaluationCase.brief,
				evaluationCase.preferences,
			),
		});
		const rawOutput = response.choices[0]?.message?.content?.trim() ?? "";
		const usage = responseUsage(response);
		const base = {
			id,
			kind: "generation" as const,
			caseId: evaluationCase.id,
			fixtureId: evaluationCase.fixtureId,
			languageId: evaluationCase.languageId,
			candidateId: candidate.id,
			model: candidate.model,
			reasoningEffort: candidate.reasoningEffort,
			repeatIndex,
			latencyMs: Math.round(performance.now() - started),
			finishReason: response.choices[0]?.finish_reason ?? null,
			usage,
			estimatedCostUsd: estimateCost(candidate.model, usage),
			rawOutput,
		};
		try {
			return { ...base, manuscript: parseReadingManuscript(rawOutput) };
		} catch (error) {
			return { ...base, validationError: errorMessage(error) };
		}
	} catch (error) {
		return {
			id,
			kind: "generation",
			caseId: evaluationCase.id,
			fixtureId: evaluationCase.fixtureId,
			languageId: evaluationCase.languageId,
			candidateId: candidate.id,
			model: candidate.model,
			reasoningEffort: candidate.reasoningEffort,
			repeatIndex,
			latencyMs: Math.round(performance.now() - started),
			finishReason: null,
			usage: blankUsage(),
			estimatedCostUsd: 0,
			rawOutput: "",
			requestError: errorMessage(error),
		};
	}
}

async function judgeCandidate(
	openai: OpenAI,
	record: GenerationRecord,
	evaluationCase: EvaluationCase,
	judgeModel: string,
): Promise<JudgmentRecord> {
	const id = `${record.id}__${judgeModel}`;
	const started = performance.now();
	try {
		const response = await openai.chat.completions.create({
			model: judgeModel,
			max_completion_tokens: 1800,
			reasoning_effort: "low",
			response_format: { type: "json_object" },
			messages: [
				{
					role: "system",
					content:
						"You are a strict multilingual language-learning editor. Evaluate an anonymous beginner reading manuscript. Return JSON only. Do not infer or discuss which model wrote it.",
				},
				{
					role: "user",
					content: JSON.stringify({
						language: getLanguage(evaluationCase.languageId),
						storyPlot: evaluationCase.storyPlot,
						brief: evaluationCase.brief,
						preferences: evaluationCase.preferences,
						manuscript: record.manuscript,
						rubric: {
							instruction:
								"Score every numeric field from 1 to 5. Be strict about grammar, the requested learning focus, and whether a beginner could read the prose without editorial repair.",
							fields: [
								"grammarAndNaturalness",
								"beginnerSuitability",
								"languageFocusAdherence",
								"plotFidelity",
								"engagement",
								"preferenceAdherence",
							],
							alsoReturn: ["needsEditing", "seriousErrors", "notes"],
						},
					}),
				},
			],
		});
		const raw = response.choices[0]?.message?.content?.trim() ?? "";
		const usage = responseUsage(response);
		return {
			id,
			kind: "judgment",
			generationId: record.id,
			judgeModel,
			latencyMs: Math.round(performance.now() - started),
			usage,
			estimatedCostUsd: estimateCost(judgeModel, usage),
			score: parseJudgeScore(raw),
		};
	} catch (error) {
		return {
			id,
			kind: "judgment",
			generationId: record.id,
			judgeModel,
			latencyMs: Math.round(performance.now() - started),
			usage: blankUsage(),
			estimatedCostUsd: 0,
			error: errorMessage(error),
		};
	}
}

export function parseJudgeScore(raw: string): JudgeScore {
	const value = JSON.parse(raw) as Record<string, unknown>;
	return {
		grammarAndNaturalness: judgeNumber(value.grammarAndNaturalness),
		beginnerSuitability: judgeNumber(value.beginnerSuitability),
		languageFocusAdherence: judgeNumber(value.languageFocusAdherence),
		plotFidelity: judgeNumber(value.plotFidelity),
		engagement: judgeNumber(value.engagement),
		preferenceAdherence: judgeNumber(value.preferenceAdherence),
		needsEditing: judgeBoolean(value.needsEditing),
		seriousErrors: Array.isArray(value.seriousErrors)
			? value.seriousErrors.filter(
					(item): item is string => typeof item === "string",
				)
			: [],
		notes: typeof value.notes === "string" ? value.notes : "",
	};
}

function judgeBoolean(value: unknown) {
	if (typeof value !== "boolean")
		throw new Error("Judge returned an invalid needsEditing value.");
	return value;
}

function judgeNumber(value: unknown) {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error("Judge returned a non-numeric score.");
	return Math.min(5, Math.max(1, value));
}

function judgeAverage(score: JudgeScore) {
	return average([
		score.grammarAndNaturalness,
		score.beginnerSuitability,
		score.languageFocusAdherence,
		score.plotFidelity,
		score.engagement,
		score.preferenceAdherence,
	]);
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

async function readJsonl<T extends { id: string }>(
	path: string,
): Promise<Map<string, T>> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw error;
	}
	const records = new Map<string, T>();
	for (const [index, line] of contents.split("\n").entries()) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line) as T;
			records.set(record.id, record);
		} catch (error) {
			throw new Error(
				`Could not parse ${path}:${index + 1}: ${errorMessage(error)}`,
			);
		}
	}
	return records;
}

async function appendJsonl(path: string, value: unknown) {
	await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function buildScores(
	runs: GenerationRecord[],
	judgments: Map<string, JudgmentRecord>,
	cases: EvaluationCase[],
	judgeModel?: string,
): CandidateScore[] {
	const casesById = new Map(cases.map((item) => [item.id, item]));
	return runs.map((run) => {
		const evaluationCase = casesById.get(run.caseId);
		if (!evaluationCase)
			throw new Error(`Missing evaluation case ${run.caseId}.`);
		const deterministic = scoreManuscriptDeterministically(run, evaluationCase);
		const judgment = judgeModel
			? [...judgments.values()].find(
					(item) =>
						item.generationId === run.id && item.judgeModel === judgeModel,
				)
			: undefined;
		const judge = judgment?.score ?? null;
		return {
			generationId: run.id,
			caseId: run.caseId,
			fixtureId: run.fixtureId,
			languageId: run.languageId,
			candidateId: run.candidateId,
			model: run.model,
			reasoningEffort: run.reasoningEffort,
			repeatIndex: run.repeatIndex,
			deterministic,
			judge,
			qualityScore: judge
				? deterministic.score * 0.3 + judgeAverage(judge) * 0.7
				: deterministic.score,
			latencyMs: run.latencyMs,
			estimatedCostUsd: run.estimatedCostUsd,
			valid: Boolean(run.manuscript),
		};
	});
}

function summarize(
	scores: CandidateScore[],
	candidates: EvalCandidate[],
): ModelSummary[] {
	const baselineId = candidates[0]?.id;
	return candidates.map((candidate) => {
		const rows = scores.filter((score) => score.candidateId === candidate.id);
		const judged = rows.flatMap((row) => (row.judge ? [row.judge] : []));
		const comparison =
			baselineId && candidate.id !== baselineId
				? compareToBaseline(
						rows,
						scores.filter((score) => score.candidateId === baselineId),
					)
				: undefined;
		return {
			candidateId: candidate.id,
			model: candidate.model,
			reasoningEffort: candidate.reasoningEffort,
			runs: rows.length,
			validRate:
				rows.filter((row) => row.valid).length / Math.max(rows.length, 1),
			averageQuality: average(rows.map((row) => row.qualityScore)),
			averageDeterministic: average(rows.map((row) => row.deterministic.score)),
			averageJudge: judged.length ? average(judged.map(judgeAverage)) : null,
			needsEditingRate: judged.length
				? judged.filter((row) => row.needsEditing).length / judged.length
				: null,
			averageCostUsd: average(rows.map((row) => row.estimatedCostUsd)),
			totalCostUsd: rows.reduce(
				(total, row) => total + row.estimatedCostUsd,
				0,
			),
			medianLatencyMs: percentile(
				rows.map((row) => row.latencyMs),
				0.5,
			),
			p95LatencyMs: percentile(
				rows.map((row) => row.latencyMs),
				0.95,
			),
			...(comparison ? { versusBaseline: comparison } : {}),
		};
	});
}

function compareToBaseline(
	candidateRows: CandidateScore[],
	baselineRows: CandidateScore[],
) {
	let wins = 0;
	let ties = 0;
	let losses = 0;
	for (const row of candidateRows) {
		const baseline = baselineRows.find(
			(item) =>
				item.caseId === row.caseId && item.repeatIndex === row.repeatIndex,
		);
		if (!baseline || Math.abs(row.qualityScore - baseline.qualityScore) < 0.1)
			ties += 1;
		else if (row.qualityScore > baseline.qualityScore) wins += 1;
		else losses += 1;
	}
	return { wins, ties, losses };
}

function buildSummaryMarkdown(
	options: ModelComparisonOptions,
	summaries: ModelSummary[],
	judgeCost: number,
) {
	const ranked = [...summaries].sort(
		(left, right) => right.averageQuality - left.averageQuality,
	);
	const lines = [
		"# Text Model Comparison",
		"",
		`Candidates: ${options.candidates.map(({ id }) => id).join(", ")}`,
		`Languages: ${options.languageIds.join(", ")}`,
		`Fixtures: ${options.fixtureIds.join(", ")}`,
		`Repeats: ${options.repeats}`,
		`Pricing checked: ${PRICING_CHECKED_AT}`,
		`Judge: ${options.judge ? options.judgeModel : "disabled"}`,
		`Judge cost: ${formatUsd(judgeCost)}`,
		"",
		"## Ranking",
		"",
		"| Candidate | Runs | Valid | Quality | Deterministic | Judge | Needs editing | Avg cost | Total cost | p50 | p95 | vs baseline |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
		...ranked.map((summary) => {
			const comparison = summary.versusBaseline;
			return `| ${summary.candidateId} | ${summary.runs} | ${formatPercent(summary.validRate)} | ${summary.averageQuality.toFixed(2)} | ${summary.averageDeterministic.toFixed(2)} | ${summary.averageJudge?.toFixed(2) ?? "-"} | ${summary.needsEditingRate === null ? "-" : formatPercent(summary.needsEditingRate)} | ${formatUsd(summary.averageCostUsd)} | ${formatUsd(summary.totalCostUsd)} | ${summary.medianLatencyMs}ms | ${summary.p95LatencyMs}ms | ${comparison ? `${comparison.wins}W/${comparison.ties}T/${comparison.losses}L` : "baseline"} |`;
		}),
		"",
		"Quality is 30% deterministic checks and 70% blinded judge scoring when judging is enabled.",
		"The first candidate is the baseline for win/tie/loss counts.",
		"Use blind-review.md for human review before changing production defaults.",
		"",
	];
	return lines.join("\n");
}

function formatUsd(value: number) {
	return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(3)}`;
}

function formatPercent(value: number) {
	return `${Math.round(value * 100)}%`;
}

function stableOrder(value: string) {
	let hash = 2166136261;
	for (const character of value) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function buildBlindReview(runs: GenerationRecord[], cases: EvaluationCase[]) {
	const key: Record<string, Record<string, string>> = {};
	const sections: string[] = [
		"# Blinded Manuscript Review",
		"",
		"For each sample, record the strongest manuscript, whether each needs editing, and any serious language-learning issue.",
		"",
	];
	for (const evaluationCase of cases) {
		const repeats = [
			...new Set(
				runs
					.filter((run) => run.caseId === evaluationCase.id)
					.map((run) => run.repeatIndex),
			),
		].sort();
		for (const repeatIndex of repeats) {
			const groupId = `${evaluationCase.id}__r${repeatIndex + 1}`;
			const group = runs
				.filter(
					(run) =>
						run.caseId === evaluationCase.id && run.repeatIndex === repeatIndex,
				)
				.sort(
					(left, right) =>
						stableOrder(`${groupId}:${left.candidateId}`) -
						stableOrder(`${groupId}:${right.candidateId}`),
				);
			const groupKey: Record<string, string> = {};
			key[groupId] = groupKey;
			sections.push(
				`## ${evaluationCase.languageId} / ${evaluationCase.fixtureId} / repeat ${repeatIndex + 1}`,
				"",
				`Focus: ${evaluationCase.brief.language.focus}`,
				"",
				`Plot: ${evaluationCase.storyPlot}`,
				"",
			);
			group.forEach((run, index) => {
				const label = String.fromCharCode(65 + index);
				groupKey[label] = run.candidateId;
				sections.push(
					`### Candidate ${label}`,
					"",
					run.manuscript
						? `**${run.manuscript.title}**\n\n${run.manuscript.text}`
						: `Generation failed: ${run.requestError ?? run.validationError}`,
					"",
				);
			});
			sections.push(
				"Reviewer choice: ___",
				"Needs editing: ___",
				"Notes: ___",
				"",
			);
		}
	}
	return { markdown: `${sections.join("\n")}\n`, key };
}

async function writeManifest(
	options: ModelComparisonOptions,
	cases: EvaluationCase[],
) {
	await writeFile(
		join(options.outputDir, "manifest.json"),
		`${JSON.stringify(
			{
				createdAt: new Date().toISOString(),
				pricingCheckedAt: PRICING_CHECKED_AT,
				productionPrompt:
					"src/reading_story/manuscript.ts#readingManuscriptMessages",
				candidates: options.candidates,
				judge: options.judge
					? { model: options.judgeModel, reasoningEffort: "low" }
					: null,
				repeats: options.repeats,
				cases,
				pricingPerMillionTokens: OPENAI_PRICING,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

export async function runTextModelComparison(rawArgs: string[]): Promise<void> {
	const options = parseTextModelComparisonArgs(rawArgs);
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	const cases = buildEvaluationCases(options.languageIds, options.fixtureIds);
	await mkdir(options.outputDir, { recursive: true });
	await writeManifest(options, cases);
	if (options.dryRun) {
		process.stdout.write(
			`Model comparison dry run ok.\nOutput: ${options.outputDir}\nCases: ${cases.length}\nGenerations: ${cases.length * options.candidates.length * options.repeats}\n`,
		);
		return;
	}

	const apiKey = process.env.OPENAI_API_KEY?.trim();
	if (!apiKey)
		throw new Error("OPENAI_API_KEY is required for model comparison.");
	const openai = new OpenAI({ apiKey });
	const runsPath = join(options.outputDir, "runs.jsonl");
	const judgmentsPath = join(options.outputDir, "judgments.jsonl");
	const runMap = await readJsonl<GenerationRecord>(runsPath);
	const judgmentMap = await readJsonl<JudgmentRecord>(judgmentsPath);

	for (const evaluationCase of cases) {
		for (const candidate of options.candidates) {
			for (
				let repeatIndex = 0;
				repeatIndex < options.repeats;
				repeatIndex += 1
			) {
				const id = `${evaluationCase.id}__${candidate.model}_${candidate.reasoningEffort}__r${repeatIndex + 1}`;
				if (!runMap.has(id)) {
					process.stderr.write(`Generating ${id}...\n`);
					const record = await generateCandidate(
						openai,
						evaluationCase,
						candidate,
						repeatIndex,
					);
					runMap.set(record.id, record);
					await appendJsonl(runsPath, record);
				}
			}
		}
	}

	if (options.judge) {
		for (const record of runMap.values()) {
			if (!record.manuscript) continue;
			const judgmentId = `${record.id}__${options.judgeModel}`;
			if (judgmentMap.has(judgmentId)) continue;
			const evaluationCase = cases.find((item) => item.id === record.caseId);
			if (!evaluationCase) continue;
			process.stderr.write(`Judging ${record.id}...\n`);
			const judgment = await judgeCandidate(
				openai,
				record,
				evaluationCase,
				options.judgeModel,
			);
			judgmentMap.set(judgment.id, judgment);
			await appendJsonl(judgmentsPath, judgment);
		}
	}

	const runs = [...runMap.values()].filter(
		(run) =>
			cases.some((item) => item.id === run.caseId) &&
			options.candidates.some((item) => item.id === run.candidateId) &&
			run.repeatIndex < options.repeats,
	);
	const scores = buildScores(
		runs,
		judgmentMap,
		cases,
		options.judge ? options.judgeModel : undefined,
	);
	const summaries = summarize(scores, options.candidates);
	const runIds = new Set(runs.map(({ id }) => id));
	const judgeCost = [...judgmentMap.values()]
		.filter(
			(judgment) =>
				options.judge &&
				judgment.judgeModel === options.judgeModel &&
				runIds.has(judgment.generationId),
		)
		.reduce((total, judgment) => total + judgment.estimatedCostUsd, 0);
	const blind = buildBlindReview(runs, cases);
	await writeFile(
		join(options.outputDir, "scores.json"),
		`${JSON.stringify({ summaries, scores }, null, 2)}\n`,
		"utf8",
	);
	await writeFile(
		join(options.outputDir, "summary.md"),
		buildSummaryMarkdown(options, summaries, judgeCost),
		"utf8",
	);
	await writeFile(
		join(options.outputDir, "blind-review.md"),
		blind.markdown,
		"utf8",
	);
	await writeFile(
		join(options.outputDir, "blind-key.json"),
		`${JSON.stringify(blind.key, null, 2)}\n`,
		"utf8",
	);
	process.stdout.write(
		`Model comparison complete.\nSummary: ${join(options.outputDir, "summary.md")}\nBlind review: ${join(options.outputDir, "blind-review.md")}\n`,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	runTextModelComparison(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`Error: ${errorMessage(error)}\n`);
		process.exitCode = 1;
	});
}
