import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	createReadingStoryComplete,
	loadCliLearnerContext,
	parseReadingStoryCliArgs,
} from "../scripts/generate-reading-story.ts";
import {
	evidenceFor,
	loadChainFeedback,
	loadStoryChainScenario,
	parseStoryChainCliArgs,
} from "../scripts/simulate-reading-story-chain.ts";
import { DEFAULT_LEARNER_CONTEXT } from "../src/learnerState.ts";
import {
	DEFAULT_STORY_GENERATION_PRESET_ID,
	getStoryGenerationPreset,
} from "../src/models.ts";

const execFileAsync = promisify(execFile);

// With no model chosen, the CLIs generate the way the app does by default.
const defaultPreset = getStoryGenerationPreset(
	DEFAULT_STORY_GENERATION_PRESET_ID,
);
const defaults = parseReadingStoryCliArgs([]);
assert.equal(defaults.model, defaultPreset.model);
assert.equal(defaults.language, "esperanto");
assert.equal(defaults.defaultLearner, false);
assert.equal(defaults.learnerStatePath, undefined);
assert.equal(defaults.reasoningEffort, defaultPreset.reasoningEffort);
// An explicit model keeps the pipeline's own reasoning default.
assert.equal(
	parseReadingStoryCliArgs(["--model", "gpt-5.6-luna"]).reasoningEffort,
	undefined,
);

const configured = parseReadingStoryCliArgs([
	"--model",
	"gpt-5.4",
	"--language",
	"german",
	"--learner-state",
	"custom.json",
	"--reasoning",
	"medium",
]);
assert.equal(configured.model, "gpt-5.4");
assert.equal(configured.language, "german");
assert.equal(configured.learnerStatePath, "custom.json");
assert.equal(configured.reasoningEffort, "medium");

assert.throws(
	() =>
		parseReadingStoryCliArgs([
			"--default-learner",
			"--learner-state",
			"custom.json",
		]),
	/cannot be used together/,
);
assert.throws(
	() => parseReadingStoryCliArgs(["--model", "unknown-model"]),
	/Unknown model/,
);
assert.throws(
	() => parseReadingStoryCliArgs(["--language", "klingon"]),
	/Unknown language/,
);
assert.throws(
	() => parseReadingStoryCliArgs(["--reasoning", "enormous"]),
	/Unknown reasoning effort/,
);
assert.throws(
	() =>
		parseReadingStoryCliArgs([
			"--model",
			"claude-sonnet-4-6",
			"--reasoning",
			"medium",
		]),
	/OpenAI GPT models/,
);
console.log("checked story CLI: arguments and defaults");

const temporaryDirectory = await mkdtemp(join(tmpdir(), "story-cli-test-"));
try {
	const validPath = join(temporaryDirectory, "valid.json");
	await writeFile(validPath, JSON.stringify(DEFAULT_LEARNER_CONTEXT), "utf8");
	assert.deepEqual(
		await loadCliLearnerContext({
			defaultLearner: false,
			learnerStatePath: validPath,
		}),
		DEFAULT_LEARNER_CONTEXT,
	);

	const invalidPath = join(temporaryDirectory, "invalid.json");
	await writeFile(invalidPath, JSON.stringify({ level: "beginner" }), "utf8");
	await assert.rejects(
		loadCliLearnerContext({
			defaultLearner: false,
			learnerStatePath: invalidPath,
		}),
		/current learner-state schema/,
	);
} finally {
	await rm(temporaryDirectory, { recursive: true });
}
console.log("checked story CLI: explicit learner state is validated");

const requestedEfforts: Array<string | undefined> = [];
const requestedModels: Array<string | undefined> = [];
const productionComplete = createReadingStoryComplete(async (request) => {
	requestedEfforts.push(request.reasoningEffort);
	requestedModels.push(request.model);
	return "{}";
});
await productionComplete([], 100, {
	model: "gpt-5.6-luna",
	reasoningEffort: "low",
});

const overriddenComplete = createReadingStoryComplete(async (request) => {
	requestedEfforts.push(request.reasoningEffort);
	return "{}";
}, "medium");
await overriddenComplete([], 100, { reasoningEffort: "low" });
assert.deepEqual(requestedEfforts, ["low", "medium"]);
assert.deepEqual(requestedModels, ["gpt-5.6-luna"]);
console.log(
	"checked story CLI: reasoning defaults and overrides are forwarded",
);

const { stdout, stderr } = await execFileAsync(
	process.execPath,
	["--import", "tsx", "scripts/generate-reading-story.ts", "--help"],
	{ cwd: process.cwd() },
);
assert.match(stdout, /Usage: npm run story:generate/);
assert.equal(stderr, "");
console.log("checked story CLI: help needs no provider credentials");

const chainDefaults = parseStoryChainCliArgs([]);
assert.equal(chainDefaults.length, 5);
assert.equal(chainDefaults.model, defaultPreset.model);
assert.equal(chainDefaults.reasoningEffort, defaultPreset.reasoningEffort);
assert.equal(
	parseStoryChainCliArgs(["--model", "gpt-5.6-luna"]).reasoningEffort,
	undefined,
);
assert.equal(chainDefaults.retries, 2);
assert.equal(chainDefaults.failHandoffAt, undefined);
assert.equal(chainDefaults.languageId, undefined);
assert.equal(
	parseStoryChainCliArgs(["--language", "german"]).languageId,
	"german",
);
assert.throws(
	() => parseStoryChainCliArgs(["--language", "klingon"]),
	/--language must be one of/,
);
assert.equal(parseStoryChainCliArgs(["-n", "3", "--json"]).length, 3);
assert.equal(
	parseStoryChainCliArgs(["--fail-handoff-at", "2"]).failHandoffAt,
	2,
);
assert.equal(
	parseStoryChainCliArgs(["--ai-log", ".artifacts/chain.ndjson"]).aiLogPath,
	".artifacts/chain.ndjson",
);
assert.equal(
	parseStoryChainCliArgs(["--scenario", "scenario.json"]).scenarioPath,
	"scenario.json",
);
assert.throws(
	() =>
		parseStoryChainCliArgs([
			"--scenario",
			"scenario.json",
			"--feedback",
			"feedback.json",
		]),
	/cannot be used together/,
);
assert.throws(
	() => parseStoryChainCliArgs(["--scenario", "scenario.json", "-n", "3"]),
	/cannot be used together/,
);
assert.throws(
	() => parseStoryChainCliArgs(["--length", "0"]),
	/positive integer/,
);
assert.throws(
	() => parseStoryChainCliArgs(["--retries", "-1"]),
	/non-negative integer/,
);
assert.throws(
	() => parseStoryChainCliArgs(["--fail-handoff-at", "0"]),
	/positive integer/,
);
assert.deepEqual(await loadChainFeedback(undefined, 2), [
	{ difficulty: "right" },
	{ difficulty: "right" },
]);
const scenarioDirectory = await mkdtemp(join(tmpdir(), "story-scenario-test-"));
try {
	const scenarioPath = join(scenarioDirectory, "scenario.json");
	await writeFile(
		scenarioPath,
		JSON.stringify({
			initialPreferences: { prefer: [], avoid: ["school routines"] },
			steps: [
				{ label: "baseline", afterStory: { difficulty: "tooEasy" } },
				{
					label: "adventure",
					beforeStory: {
						preferences: {
							prefer: ["adventurous stories"],
							avoid: ["school routines"],
						},
						theme: "A cave expedition",
					},
				},
			],
		}),
		"utf8",
	);
	const scenario = await loadStoryChainScenario(scenarioPath);
	assert.equal(scenario.steps.length, 2);
	assert.deepEqual(scenario.initialPreferences, {
		prefer: [],
		avoid: ["school routines"],
	});
	assert.equal(scenario.steps[1].beforeStory?.theme, "A cave expedition");
	assert.deepEqual(scenario.steps[1].beforeStory?.preferences?.prefer, [
		"adventurous stories",
	]);
} finally {
	await rm(scenarioDirectory, { recursive: true });
}
const story = {
	title: "Testo",
	storySummary: "A simple test.",
	languageFocus: "estas",
	visualContext: "",
	properNames: [],
	imagePrompts: [],
	parts: [{ text: "Jen unu." }, { text: "Jen du." }],
};
assert.deepEqual(
	evidenceFor(story, {
		difficulty: "bitHard",
		practiceRequest: "  accusative  ",
		wordLookups: ["jen"],
	}),
	{
		storySummary: "A simple test.",
		storyParts: ["Jen unu.", "Jen du."],
		languageFocus: "estas",
		wordLookups: ["jen"],
		learnerQuestions: [],
		recapResults: [],
		recentStories: [],
		difficulty: "bitHard",
		practiceRequest: "accusative",
	},
);
const chainHelp = await execFileAsync(
	process.execPath,
	["--import", "tsx", "scripts/simulate-reading-story-chain.ts", "--help"],
	{ cwd: process.cwd() },
);
assert.match(chainHelp.stdout, /Usage: npm run story:chain/);
assert.equal(chainHelp.stderr, "");
console.log("checked story chain CLI: arguments, evidence, defaults, and help");

console.log("\nstory CLI checks passed");
