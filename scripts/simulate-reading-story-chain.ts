/** Simulate the production reading-story handoff chain without generating media. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import {
	getLanguage,
	isLanguageId,
	type Language,
	type LanguageId,
	languages,
	starterBriefForLanguage,
} from "../src/languages.ts";
import type {
	LearnerContext,
	LearnerPreferences,
	RecentStoryMemory,
} from "../src/learnerState.ts";
import { mergeStoryMemory } from "../src/learnerState.ts";
import {
	DEFAULT_TEXT_MODEL,
	TEXT_MODELS,
	TEXT_REASONING_EFFORTS,
	type TextModelId,
	type TextReasoningEffort,
} from "../src/models.ts";
import {
	type NextStoryBrief,
	STARTER_NEXT_STORY_BRIEF,
} from "../src/nextStoryBrief.ts";
import { dialogueSegments } from "../src/reading_story/dialogue.ts";
import { completeStructuredAi } from "../src/server/aiService.ts";
import {
	createAiTraceContext,
	flushAiTraceLog,
	withAiTraceContext,
	withAiTraceMetadata,
} from "../src/server/aiTrace.ts";
import {
	generateNextStoryBrief,
	type NextStoryEvidence,
	recoverNextStoryBrief,
} from "../src/server/nextStoryBriefService.ts";
import { generateReadingStory, type ReadingStory } from "../src/story.ts";
import {
	STORY_DIFFICULTIES,
	type StoryDifficulty,
} from "../src/storyFeedback.ts";
import {
	createReadingStoryComplete,
	loadCliLearnerContext,
	requireProviderKeys,
} from "./generate-reading-story.ts";

export interface ChainFeedback {
	difficulty?: StoryDifficulty;
	practiceRequest?: string;
	nextStoryTheme?: string;
	wordLookups?: string[];
	learnerQuestions?: string[];
	recapResults?: Array<{ type: string; label: string; attempts: number }>;
}

export interface StoryChainCliOptions {
	aiLogPath?: string;
	defaultLearner: boolean;
	feedbackPath?: string;
	failHandoffAt?: number;
	help: boolean;
	json: boolean;
	languageId?: LanguageId;
	learnerStatePath?: string;
	length: number;
	model: TextModelId;
	reasoningEffort?: TextReasoningEffort;
	retries: number;
	scenarioPath?: string;
}

export interface StoryChainStep {
	index: number;
	label?: string;
	inputBrief: NextStoryBrief;
	explicitTheme: string;
	storySubject?: string;
	themeSource: "explicit" | "handoff" | "open-choice";
	preferences: Pick<LearnerPreferences, "prefer" | "avoid">;
	story: ReadingStory;
	feedback: ChainFeedback;
	nextStoryBrief: NextStoryBrief;
	recentStory: RecentStoryMemory | null;
	handoffRecovered: boolean;
}

export interface StoryChainScenario {
	initialPreferences?: Pick<LearnerPreferences, "prefer" | "avoid">;
	steps: StoryChainScenarioStep[];
}

export interface StoryChainScenarioStep {
	label?: string;
	beforeStory?: {
		preferences?: Pick<LearnerPreferences, "prefer" | "avoid">;
		theme?: string;
	};
	afterStory?: ChainFeedback;
}

const HELP = `Usage: npm run story:chain -- --length <n> [options]

Generate a chain of reading stories through the production prose and next-story
brief pipeline. It does not synthesize narration or call an image-generation API.

Options:
  -n, --length <n>        Number of stories to generate (default: 5)
  --language <id>         Story language (default: ${languages[0]?.id}); starts from its starter brief
  --feedback <path>       JSON feedback object, or an array with one per story
  --scenario <path>       JSON timeline of before-story changes and after-story evidence
  --fail-handoff-at <n>   Simulate a malformed handoff after story n
  --ai-log <path>         Write full provider calls to a separate NDJSON trace
  --model <id>            Prose model (default: ${DEFAULT_TEXT_MODEL})
  --reasoning <effort>    OpenAI prose only: ${TEXT_REASONING_EFFORTS.join("|")}
  --retries <n>           Retry a rejected story up to n times (default: 2)
  --learner-state <path>  Use and validate a custom learner-state JSON file
  --default-learner       Use the built-in default learner state
  --json                  Emit one JSON document instead of a readable report
  --help                  Show this help

With no --feedback file, each story receives neutral {"difficulty":"right"}
feedback. A one-object file is reused for every story. An array must contain at
least n entries. Supported evidence fields are difficulty, practiceRequest,
nextStoryTheme, wordLookups, learnerQuestions, and recapResults.

A scenario defines the chain length through its steps. Each step may replace
effective prefer/avoid settings and set an explicit theme before that story is
generated, then supply feedback after it. --scenario cannot be combined with
--feedback or --length.
`;

export function parseStoryChainCliArgs(
	rawArgs: string[],
): StoryChainCliOptions {
	const options: StoryChainCliOptions = {
		defaultLearner: false,
		help: false,
		json: false,
		length: 5,
		model: DEFAULT_TEXT_MODEL,
		retries: 2,
	};
	let lengthWasSet = false;
	for (let index = 0; index < rawArgs.length; index += 1) {
		const argument = rawArgs[index];
		switch (argument) {
			case "--help":
				options.help = true;
				break;
			case "--json":
				options.json = true;
				break;
			case "--default-learner":
				options.defaultLearner = true;
				break;
			case "-n":
			case "--length": {
				lengthWasSet = true;
				const value = requiredFlagValue(rawArgs, index, argument);
				options.length = Number(value);
				if (!Number.isSafeInteger(options.length) || options.length < 1) {
					throw new Error(`${argument} must be a positive integer.`);
				}
				index += 1;
				break;
			}
			case "--language": {
				const value = requiredFlagValue(rawArgs, index, argument);
				if (!isLanguageId(value)) {
					throw new Error(
						`${argument} must be one of: ${languages.map((language) => language.id).join(", ")}.`,
					);
				}
				options.languageId = value;
				index += 1;
				break;
			}
			case "--feedback":
				options.feedbackPath = requiredFlagValue(rawArgs, index, argument);
				index += 1;
				break;
			case "--fail-handoff-at": {
				const value = requiredFlagValue(rawArgs, index, argument);
				options.failHandoffAt = Number(value);
				if (
					!Number.isSafeInteger(options.failHandoffAt) ||
					options.failHandoffAt < 1
				) {
					throw new Error(`${argument} must be a positive integer.`);
				}
				index += 1;
				break;
			}
			case "--scenario":
				options.scenarioPath = requiredFlagValue(rawArgs, index, argument);
				index += 1;
				break;
			case "--ai-log":
				options.aiLogPath = requiredFlagValue(rawArgs, index, argument);
				index += 1;
				break;
			case "--retries": {
				const value = requiredFlagValue(rawArgs, index, argument);
				options.retries = Number(value);
				if (!Number.isSafeInteger(options.retries) || options.retries < 0) {
					throw new Error(`${argument} must be a non-negative integer.`);
				}
				index += 1;
				break;
			}
			case "--learner-state":
				options.learnerStatePath = requiredFlagValue(rawArgs, index, argument);
				index += 1;
				break;
			case "--model": {
				const value = requiredFlagValue(rawArgs, index, argument);
				const model = TEXT_MODELS.find((candidate) => candidate.id === value);
				if (!model) throw new Error(`Unknown model "${value}".`);
				options.model = model.id;
				index += 1;
				break;
			}
			case "--reasoning": {
				const value = requiredFlagValue(rawArgs, index, argument);
				if (!TEXT_REASONING_EFFORTS.includes(value as TextReasoningEffort)) {
					throw new Error(`Unknown reasoning effort "${value}".`);
				}
				options.reasoningEffort = value as TextReasoningEffort;
				index += 1;
				break;
			}
			default:
				throw new Error(
					`Unknown argument "${argument}". Use --help for usage.`,
				);
		}
	}
	if (options.defaultLearner && options.learnerStatePath) {
		throw new Error(
			"--default-learner and --learner-state cannot be used together.",
		);
	}
	if (options.scenarioPath && options.feedbackPath) {
		throw new Error("--scenario and --feedback cannot be used together.");
	}
	if (options.scenarioPath && lengthWasSet) {
		throw new Error("--scenario and --length cannot be used together.");
	}
	if (options.reasoningEffort && !options.model.startsWith("gpt-")) {
		throw new Error("--reasoning is supported only for OpenAI GPT models.");
	}
	return options;
}

export async function loadStoryChainScenario(
	path: string,
): Promise<StoryChainScenario> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read scenario "${path}": ${message}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Scenario must be an object.");
	}
	const scenario = value as Record<string, unknown>;
	assertOnlyKeys(scenario, ["initialPreferences", "steps"], "Scenario");
	if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
		throw new Error("Scenario steps must be a non-empty array.");
	}
	return {
		...(scenario.initialPreferences === undefined
			? {}
			: {
					initialPreferences: parseScenarioPreferences(
						scenario.initialPreferences,
						"Scenario initialPreferences",
					),
				}),
		steps: scenario.steps.map(parseScenarioStep),
	};
}

function parseScenarioStep(
	value: unknown,
	index: number,
): StoryChainScenarioStep {
	const location = `Scenario step ${index + 1}`;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${location} must be an object.`);
	}
	const step = value as Record<string, unknown>;
	assertOnlyKeys(step, ["label", "beforeStory", "afterStory"], location);
	if (step.label !== undefined && typeof step.label !== "string") {
		throw new Error(`${location} label must be a string.`);
	}
	let beforeStory: StoryChainScenarioStep["beforeStory"];
	if (step.beforeStory !== undefined) {
		if (
			!step.beforeStory ||
			typeof step.beforeStory !== "object" ||
			Array.isArray(step.beforeStory)
		) {
			throw new Error(`${location} beforeStory must be an object.`);
		}
		const before = step.beforeStory as Record<string, unknown>;
		assertOnlyKeys(before, ["preferences", "theme"], `${location} beforeStory`);
		if (before.theme !== undefined && typeof before.theme !== "string") {
			throw new Error(`${location} beforeStory theme must be a string.`);
		}
		beforeStory = {
			...(before.preferences === undefined
				? {}
				: {
						preferences: parseScenarioPreferences(
							before.preferences,
							`${location} preferences`,
						),
					}),
			...(before.theme === undefined ? {} : { theme: before.theme.trim() }),
		};
	}
	return {
		...(typeof step.label === "string" && step.label.trim()
			? { label: step.label.trim() }
			: {}),
		...(beforeStory ? { beforeStory } : {}),
		...(step.afterStory === undefined
			? {}
			: { afterStory: parseFeedback(step.afterStory, index) }),
	};
}

function parseScenarioPreferences(
	value: unknown,
	location: string,
): Pick<LearnerPreferences, "prefer" | "avoid"> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${location} must be an object.`);
	}
	const preferences = value as Record<string, unknown>;
	assertOnlyKeys(preferences, ["prefer", "avoid"], location);
	for (const field of ["prefer", "avoid"] as const) {
		if (
			!Array.isArray(preferences[field]) ||
			preferences[field].length > 8 ||
			preferences[field].some(
				(item) =>
					typeof item !== "string" || !item.trim() || item.trim().length > 180,
			)
		) {
			throw new Error(
				`${location} ${field} must contain at most 8 non-empty strings of at most 180 characters.`,
			);
		}
	}
	return {
		prefer: (preferences.prefer as string[]).map((item) => item.trim()),
		avoid: (preferences.avoid as string[]).map((item) => item.trim()),
	};
}

function assertOnlyKeys(
	value: Record<string, unknown>,
	allowed: string[],
	location: string,
) {
	const unknown = Object.keys(value).find((key) => !allowed.includes(key));
	if (unknown) throw new Error(`${location} has unknown field "${unknown}".`);
}

function requiredFlagValue(
	args: string[],
	index: number,
	flag: string,
): string {
	const value = args[index + 1]?.trim();
	if (!value || value.startsWith("--"))
		throw new Error(`${flag} requires a value.`);
	return value;
}

export async function loadChainFeedback(
	path: string | undefined,
	length: number,
): Promise<ChainFeedback[]> {
	if (!path) return Array.from({ length }, () => ({ difficulty: "right" }));
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read feedback "${path}": ${message}`);
	}
	const values = Array.isArray(value)
		? value
		: Array.from({ length }, () => value);
	if (values.length < length) {
		throw new Error(
			`Feedback array has ${values.length} entries; ${length} are required.`,
		);
	}
	return values
		.slice(0, length)
		.map((item, index) => parseFeedback(item, index));
}

function parseFeedback(value: unknown, index: number): ChainFeedback {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Feedback entry ${index + 1} must be an object.`);
	}
	const item = value as Record<string, unknown>;
	const allowed = new Set([
		"difficulty",
		"practiceRequest",
		"nextStoryTheme",
		"wordLookups",
		"learnerQuestions",
		"recapResults",
	]);
	const unknown = Object.keys(item).find((key) => !allowed.has(key));
	if (unknown)
		throw new Error(
			`Feedback entry ${index + 1} has unknown field "${unknown}".`,
		);
	if (
		item.difficulty !== undefined &&
		!STORY_DIFFICULTIES.includes(item.difficulty as StoryDifficulty)
	) {
		throw new Error(`Feedback entry ${index + 1} has an invalid difficulty.`);
	}
	for (const field of ["practiceRequest", "nextStoryTheme"] as const) {
		if (item[field] !== undefined && typeof item[field] !== "string") {
			throw new Error(
				`Feedback entry ${index + 1} field ${field} must be a string.`,
			);
		}
	}
	for (const field of ["wordLookups", "learnerQuestions"] as const) {
		if (
			item[field] !== undefined &&
			(!Array.isArray(item[field]) ||
				item[field].some((entry) => typeof entry !== "string"))
		) {
			throw new Error(
				`Feedback entry ${index + 1} field ${field} must be a string array.`,
			);
		}
	}
	if (
		item.recapResults !== undefined &&
		(!Array.isArray(item.recapResults) ||
			item.recapResults.some((result) => !validRecapResult(result)))
	) {
		throw new Error(`Feedback entry ${index + 1} has invalid recapResults.`);
	}
	return item as ChainFeedback;
}

function validRecapResult(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const result = value as Record<string, unknown>;
	return (
		typeof result.type === "string" &&
		typeof result.label === "string" &&
		typeof result.attempts === "number" &&
		Number.isFinite(result.attempts) &&
		result.attempts >= 1
	);
}

export function evidenceFor(
	story: ReadingStory,
	feedback: ChainFeedback,
	recentStories: RecentStoryMemory[] = [],
): NextStoryEvidence {
	return {
		storySummary: story.storySummary,
		storyParts: story.parts.map((part) => part.text),
		languageFocus: story.languageFocus,
		wordLookups: feedback.wordLookups ?? [],
		learnerQuestions: feedback.learnerQuestions ?? [],
		recapResults: feedback.recapResults ?? [],
		recentStories,
		...(feedback.difficulty ? { difficulty: feedback.difficulty } : {}),
		...(feedback.practiceRequest?.trim()
			? { practiceRequest: feedback.practiceRequest.trim() }
			: {}),
	};
}

async function simulateChain(
	options: StoryChainCliOptions,
	learner: LearnerContext,
	feedbackItems: ChainFeedback[],
	scenario?: StoryChainScenario,
	onStep?: (step: StoryChainStep) => void,
): Promise<StoryChainStep[]> {
	const { anthropicKey, openaiKey } = requireProviderKeys(options.model);
	const openai = new OpenAI({ apiKey: openaiKey });
	const complete = createReadingStoryComplete(
		({ messages, maxTokens, model, reasoningEffort }) =>
			withAiTraceMetadata(
				{ chainStage: classifyChainStage(messages[0]?.content ?? "") },
				() =>
					completeStructuredAi(
						openai,
						messages,
						maxTokens,
						model ?? options.model,
						anthropicKey,
						{ reasoningEffort },
					),
			),
		options.reasoningEffort,
	);
	const genre = chainLanguage(options);
	let preferences = structuredClone(
		scenario?.initialPreferences ?? {
			prefer: learner.preferences.prefer,
			avoid: learner.preferences.avoid,
		},
	);
	let storyMemory = structuredClone(learner.storyMemory);
	const steps: StoryChainStep[] = [];
	let inputBrief = options.languageId
		? starterBriefForLanguage(genre)
		: STARTER_NEXT_STORY_BRIEF;
	let pendingExplicitTheme = "";
	const length = scenario?.steps.length ?? options.length;
	if (options.failHandoffAt && options.failHandoffAt > length) {
		throw new Error("--fail-handoff-at must identify a story in the chain.");
	}
	for (let index = 0; index < length; index += 1) {
		const scenarioStep = scenario?.steps[index];
		if (scenarioStep?.beforeStory?.preferences) {
			preferences = structuredClone(scenarioStep.beforeStory.preferences);
		}
		const explicitTheme =
			scenarioStep?.beforeStory?.theme !== undefined
				? scenarioStep.beforeStory.theme
				: pendingExplicitTheme;
		const themeSource: StoryChainStep["themeSource"] = explicitTheme
			? "explicit"
			: inputBrief.themeSuggestion
				? "handoff"
				: "open-choice";
		const storySubject =
			explicitTheme || inputBrief.themeSuggestion || undefined;
		process.stderr.write(
			`Generating story ${index + 1}/${length}${scenarioStep?.label ? ` (${scenarioStep.label})` : ""}...\n`,
		);
		const story = await generateStoryWithRetries(
			() =>
				withAiTraceMetadata(
					{ chainIndex: index + 1, chainPhase: "story" },
					() =>
						generateReadingStory(complete, genre, preferences, explicitTheme, {
							reasoningEffort: options.reasoningEffort,
							nextStoryBrief: inputBrief,
							recentStories: storyMemory.recentStories,
						}),
				),
			options.retries,
			index + 1,
		);
		const feedback =
			scenarioStep?.afterStory ??
			feedbackItems[index] ??
			({ difficulty: "right" } satisfies ChainFeedback);
		const handoffEvidence = evidenceFor(
			story,
			feedback,
			storyMemory.recentStories,
		);
		const handoff =
			options.failHandoffAt === index + 1
				? {
						nextStoryBrief: recoverNextStoryBrief(handoffEvidence, inputBrief),
						recentStory: null,
						recovered: true,
					}
				: await withAiTraceMetadata(
						{
							chainIndex: index + 1,
							chainPhase: "handoff",
							chainStage: "handoff",
						},
						() =>
							generateNextStoryBrief(
								openai,
								genre,
								handoffEvidence,
								anthropicKey,
								inputBrief,
							),
					);
		const { nextStoryBrief, recentStory, recovered } = handoff;
		if (recentStory) {
			storyMemory = mergeStoryMemory(
				storyMemory,
				recentStory,
				new Date().toISOString().slice(0, 10),
			);
		}
		const step = {
			index: index + 1,
			...(scenarioStep?.label ? { label: scenarioStep.label } : {}),
			inputBrief,
			explicitTheme,
			...(storySubject ? { storySubject } : {}),
			themeSource,
			preferences: structuredClone(preferences),
			story,
			feedback,
			nextStoryBrief,
			recentStory,
			handoffRecovered: recovered,
		};
		steps.push(step);
		onStep?.(step);
		inputBrief = nextStoryBrief;
		pendingExplicitTheme = feedback.nextStoryTheme?.trim() ?? "";
	}
	return steps;
}

function classifyChainStage(systemPrompt: string): string {
	if (systemPrompt.startsWith("Task: Prepare a short story plot"))
		return "plot-draft";
	if (systemPrompt.startsWith("You are reviewing a short story draft"))
		return "plot-review";
	if (systemPrompt.startsWith("Author the finished manuscript"))
		return "manuscript";
	if (systemPrompt.startsWith("Divide an already finished")) return "split";
	if (systemPrompt.startsWith("Design a coherent visual plan"))
		return "visual-plan";
	if (systemPrompt.startsWith("Repair the supplied output")) return "repair";
	return "other";
}

async function generateStoryWithRetries(
	generate: () => Promise<ReadingStory>,
	retries: number,
	storyIndex: number,
): Promise<ReadingStory> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await generate();
		} catch (error) {
			if (attempt >= retries) throw error;
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(
				`Story ${storyIndex} was rejected (${message}); retrying ${attempt + 1}/${retries}...\n`,
			);
		}
	}
}

function chainLanguage(options: Pick<StoryChainCliOptions, "languageId">) {
	const genre = options.languageId
		? getLanguage(options.languageId)
		: languages[0];
	if (!genre) throw new Error("No reading-story genre is configured.");
	return genre;
}

/** Part prose with each quotation followed by its attributed [speaker: delivery]. */
function attributedParts(story: ReadingStory, genre: Language): string {
	let dialogueIndex = 0;
	return story.parts
		.map((part, index) => {
			const segments = dialogueSegments(
				part.text,
				genre.dialogueQuotes,
				dialogueIndex,
			);
			const text = segments
				.map((segment) => {
					if (segment.dialogueIndex === undefined) return segment.text;
					dialogueIndex += 1;
					const line = story.dialogue?.[segment.dialogueIndex];
					return `${segment.text} [${line?.speaker ?? "?"}: ${line?.delivery ?? "?"}]`;
				})
				.join("");
			return `Part ${index + 1}:\n${text}`;
		})
		.join("\n\n");
}

function formatReadable(steps: StoryChainStep[], genre: Language): string {
	return `${steps
		.map((step) => {
			const parts = attributedParts(step.story, genre);
			const characters = step.story.characters?.length
				? step.story.characters
						.map((character) => `${character.name} (${character.voiceType})`)
						.join(", ")
				: "(none)";
			return [
				`${"=".repeat(72)}\nSTORY ${step.index}${step.label ? ` [${step.label}]` : ""}: ${step.story.title}`,
				`Effective preferences before generation:\n${JSON.stringify(step.preferences, null, 2)}`,
				`Input brief:\n${JSON.stringify(step.inputBrief, null, 2)}`,
				`Story subject (${step.themeSource}):\n${step.storySubject ?? "(model chooses freely)"}`,
				`Plot summary:\n${step.story.storySummary}`,
				`Language focus:\n${step.story.languageFocus}`,
				`Speaking characters: ${characters}`,
				parts,
				`Simulated learner feedback:\n${JSON.stringify(step.feedback, null, 2)}`,
				`Completed-story memory added to FIFO:\n${JSON.stringify(step.recentStory, null, 2)}`,
				`Handoff recovery used: ${step.handoffRecovered ? "yes" : "no"}`,
				`Generated handoff to story ${step.index + 1}:\n${JSON.stringify(step.nextStoryBrief, null, 2)}`,
			].join("\n\n");
		})
		.join("\n\n")}\n`;
}

export async function runStoryChainCli(rawArgs: string[]): Promise<void> {
	const options = parseStoryChainCliArgs(rawArgs);
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	if (options.aiLogPath) {
		process.env.AI_CALL_LOG = "1";
		process.env.AI_CALL_LOG_PAYLOAD = "full";
		process.env.AI_CALL_LOG_PATH = resolve(options.aiLogPath);
	}
	const learner = await loadCliLearnerContext(options);
	const scenario = options.scenarioPath
		? await loadStoryChainScenario(options.scenarioPath)
		: undefined;
	const feedback = scenario
		? []
		: await loadChainFeedback(options.feedbackPath, options.length);
	try {
		const steps = await withAiTraceContext(
			createAiTraceContext("CLI", "story:chain"),
			() =>
				simulateChain(
					options,
					learner,
					feedback,
					scenario,
					options.json
						? undefined
						: (step) =>
								process.stdout.write(
									formatReadable([step], chainLanguage(options)),
								),
				),
		);
		if (options.json)
			process.stdout.write(`${JSON.stringify(steps, null, 2)}\n`);
	} finally {
		await flushAiTraceLog();
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	runStoryChainCli(process.argv.slice(2)).catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Error: ${message}\n`);
		process.exitCode = 1;
	});
}
