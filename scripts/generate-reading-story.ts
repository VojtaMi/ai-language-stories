/** Generate one complete reading story through the production story pipeline. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import {
	DEFAULT_LANGUAGE,
	getLanguage,
	isLanguageId,
	type LanguageId,
	languages,
} from "../src/languages.ts";
import {
	DEFAULT_LEARNER_CONTEXT,
	type LearnerContext,
	parseLearnerContext,
} from "../src/learnerState.ts";
import {
	DEFAULT_TEXT_MODEL,
	TEXT_MODELS,
	TEXT_REASONING_EFFORTS,
	type TextModelId,
	type TextReasoningEffort,
} from "../src/models.ts";
import { completeStructuredAi } from "../src/server/aiService.ts";
import { readLearnerContext } from "../src/server/learnerProfileStore.ts";
import { LOCAL_LEARNER_ID } from "../src/server/learnerScope.ts";
import {
	type ChatMessage,
	type Complete,
	generateReadingStory,
} from "../src/story.ts";

export type ReadingStoryCliOptions = {
	defaultLearner: boolean;
	help: boolean;
	learnerStatePath?: string;
	language: LanguageId;
	model: TextModelId;
	reasoningEffort?: TextReasoningEffort;
};

type StructuredCompletion = (request: {
	messages: ChatMessage[];
	maxTokens: number;
	model?: TextModelId;
	reasoningEffort?: TextReasoningEffort;
}) => Promise<string>;

const languageIds = languages.map(({ id }) => id);

const HELP = `Usage: npm run story:generate -- [options]

Generate one complete adaptively-sectioned reading story and print its JSON to stdout.

Options:
  --language <id>          Story language: ${languageIds.join("|")} (default: ${DEFAULT_LANGUAGE.id})
  --model <id>             Text model (default: ${DEFAULT_TEXT_MODEL})
  --learner-state <path>   Use and validate a custom learner-state JSON file
  --default-learner        Use the built-in default learner state
  --reasoning <effort>     OpenAI only: ${TEXT_REASONING_EFFORTS.join("|")}
  --help                   Show this help

OPENAI_API_KEY is always required for Luna plot preparation. The selected
prose model may require an additional provider key.
`;

export function parseReadingStoryCliArgs(
	rawArgs: string[],
): ReadingStoryCliOptions {
	const options: ReadingStoryCliOptions = {
		defaultLearner: false,
		help: false,
		language: DEFAULT_LANGUAGE.id,
		model: DEFAULT_TEXT_MODEL,
	};

	for (let index = 0; index < rawArgs.length; index += 1) {
		const argument = rawArgs[index];
		switch (argument) {
			case "--help":
				options.help = true;
				break;
			case "--default-learner":
				options.defaultLearner = true;
				break;
			case "--language": {
				const value = requiredFlagValue(rawArgs, index, argument);
				if (!isLanguageId(value)) {
					throw new Error(
						`Unknown language "${value}". Valid languages: ${languageIds.join(", ")}`,
					);
				}
				options.language = value;
				index += 1;
				break;
			}
			case "--model": {
				const value = requiredFlagValue(rawArgs, index, argument);
				const model = TEXT_MODELS.find((candidate) => candidate.id === value);
				if (!model) {
					throw new Error(
						`Unknown model "${value}". Valid models: ${TEXT_MODELS.map(({ id }) => id).join(", ")}`,
					);
				}
				options.model = model.id;
				index += 1;
				break;
			}
			case "--learner-state":
				options.learnerStatePath = requiredFlagValue(rawArgs, index, argument);
				index += 1;
				break;
			case "--reasoning": {
				const value = requiredFlagValue(rawArgs, index, argument);
				if (!TEXT_REASONING_EFFORTS.includes(value as TextReasoningEffort)) {
					throw new Error(
						`Unknown reasoning effort "${value}". Valid values: ${TEXT_REASONING_EFFORTS.join(", ")}`,
					);
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
	if (options.reasoningEffort && !options.model.startsWith("gpt-")) {
		throw new Error("--reasoning is supported only for OpenAI GPT models.");
	}
	return options;
}

function requiredFlagValue(
	rawArgs: string[],
	index: number,
	flag: string,
): string {
	const value = rawArgs[index + 1]?.trim();
	if (!value || value.startsWith("--")) {
		throw new Error(`${flag} requires a value.`);
	}
	return value;
}

export async function loadCliLearnerContext(
	options: Pick<ReadingStoryCliOptions, "defaultLearner" | "learnerStatePath">,
): Promise<LearnerContext> {
	if (options.defaultLearner) {
		return structuredClone(DEFAULT_LEARNER_CONTEXT);
	}
	if (!options.learnerStatePath) return readLearnerContext(LOCAL_LEARNER_ID);

	let raw: string;
	try {
		raw = await readFile(options.learnerStatePath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Could not read learner state "${options.learnerStatePath}": ${message}`,
		);
	}

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(
			`Learner state "${options.learnerStatePath}" is not valid JSON.`,
		);
	}
	const context = parseLearnerContext(value);
	if (!context) {
		throw new Error(
			`Learner state "${options.learnerStatePath}" does not match the current learner-state schema.`,
		);
	}
	return context;
}

export function createReadingStoryComplete(
	completeStructured: StructuredCompletion,
	reasoningOverride?: TextReasoningEffort,
): Complete {
	return (messages, maxTokens, options) =>
		completeStructured({
			messages,
			maxTokens,
			model: options?.model,
			reasoningEffort: options?.model
				? options.reasoningEffort
				: (reasoningOverride ?? options?.reasoningEffort),
		});
}

export function requireProviderKeys(model: TextModelId): {
	anthropicKey: string;
	openaiKey: string;
} {
	const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
	const geminiKey = process.env.GEMINI_API_KEY ?? "";
	const openaiKey = process.env.OPENAI_API_KEY ?? "";
	if (model.startsWith("claude-") && !anthropicKey) {
		throw new Error("ANTHROPIC_API_KEY is required for Claude models.");
	}
	if (model.startsWith("gemini-") && !geminiKey) {
		throw new Error("GEMINI_API_KEY is required for Gemini models.");
	}
	if (!openaiKey) {
		throw new Error(
			"OPENAI_API_KEY is required for Luna reading-story plot preparation.",
		);
	}
	return { anthropicKey, openaiKey };
}

export async function runReadingStoryCli(rawArgs: string[]): Promise<void> {
	const options = parseReadingStoryCliArgs(rawArgs);
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}

	const learnerContext = await loadCliLearnerContext(options);
	const { anthropicKey, openaiKey } = requireProviderKeys(options.model);
	const openai = new OpenAI({ apiKey: openaiKey || "unused-by-provider" });
	const complete = createReadingStoryComplete(
		({ messages, maxTokens, model, reasoningEffort }) =>
			completeStructuredAi(
				openai,
				messages,
				maxTokens,
				model ?? options.model,
				anthropicKey,
				{ reasoningEffort },
			),
		options.reasoningEffort,
	);
	const genre = getLanguage(options.language);
	const story = await generateReadingStory(complete, genre, {
		prefer: learnerContext.preferences.prefer,
		avoid: learnerContext.preferences.avoid,
	});
	process.stdout.write(`${JSON.stringify(story, null, 2)}\n`);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	runReadingStoryCli(process.argv.slice(2)).catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Error: ${message}\n`);
		process.exitCode = 1;
	});
}
