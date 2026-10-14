import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The story-finish evidence manager's correctness lives in two stores: word
 * lookups are attributed to the story they happened in (so a delayed baseline
 * can't consume another story's lookups), and the per-story finalization record
 * makes finalization idempotent. Both are pure filesystem logic — no provider —
 * so these assert the properties directly. The refine handlers are thin
 * orchestration over them.
 *
 * The stores resolve `learner/` and `stories/` from process.cwd() at import
 * time, so we chdir into a scratch directory before importing them.
 */
const originalCwd = process.cwd();
const workDir = await mkdtemp(join(tmpdir(), "finish-evidence-"));
process.chdir(workDir);

const {
	appendLearnerWordLogEntry,
	readWordLookupsForStory,
	pruneWordLogForStory,
} = await import("../src/server/learnerWordLogStore.ts");
const { readFinishEvidence, updateFinishEvidence } = await import(
	"../src/server/storyFinishEvidenceStore.ts"
);
const { requireLearnerId, learnerStateDir } = await import(
	"../src/server/learnerScope.ts"
);
const { readLearnerContext, writeLearnerContext } = await import(
	"../src/server/learnerProfileStore.ts"
);
const { parseLearnerContext, mergeStoryMemory, DEFAULT_LEARNER_PREFERENCES } =
	await import("../src/learnerState.ts");
const { finalizeStoryEvidence } = await import(
	"../src/server/storyFinalizationService.ts"
);
const { bundledFinishEvidencePath } = await import(
	"../src/server/storyBundleStore.ts"
);

const storyA = "esperanto--story-a--0001";
const storyB = "german--story-b--0002";
const storyC = "esperanto--story-c--0003";
const learner = "11111111-1111-4111-8111-111111111111";
const otherLearner = "22222222-2222-4222-8222-222222222222";
const storyD = "spanish--story-d--0004";

assert.equal(
	bundledFinishEvidencePath(storyB),
	join(workDir, "stories", "german", storyB, "finish-evidence.json"),
);

const storyMemory = {
	version: 1 as const,
	updated: "2026-07-16",
	recentStories: [
		{
			genreId: "esperanto",
			motif: "existing motif",
			protagonist: "existing protagonist",
			setting: "existing setting",
			elements: ["existing element"],
		},
	],
};

try {
	// --- Word-log scoping ---------------------------------------------------
	// Story A looked up twice, story B once, and another learner's lookup.
	await appendLearnerWordLogEntry(learner, "hundo", storyA);
	await appendLearnerWordLogEntry(learner, "hundo", storyA);
	await appendLearnerWordLogEntry(learner, "kato", storyB);
	await appendLearnerWordLogEntry(otherLearner, "hundo", storyA);

	const aLookups = await readWordLookupsForStory(learner, storyA);
	assert.deepEqual(aLookups.aggregated, [{ word: "hundo", count: 2 }]);
	assert.deepEqual(aLookups.lookups, ["hundo (2x)"]);
	console.log("checked word-log: story A gets only its own aggregated lookups");
	assert.deepEqual(
		(await readWordLookupsForStory(otherLearner, storyA)).aggregated,
		[{ word: "hundo", count: 1 }],
		"another learner's lookups never mix into this learner's",
	);
	console.log("checked word-log: learners keep separate logs");

	const bLookups = await readWordLookupsForStory(learner, storyB);
	assert.deepEqual(bLookups.aggregated, [{ word: "kato", count: 1 }]);

	// --- Story A finalizes before B; B's lookup stays attributed to B -------
	// This is the leak the manager exists to prevent: A consuming B's lookups.
	await pruneWordLogForStory(learner, storyA);
	assert.deepEqual(
		(await readWordLookupsForStory(learner, storyA)).aggregated,
		[],
		"A's scoped lookups are consumed by its own finalization",
	);
	assert.deepEqual(
		(await readWordLookupsForStory(learner, storyB)).aggregated,
		[{ word: "kato", count: 1 }],
		"B's lookup remains attributed to B after A finalizes",
	);
	console.log(
		"checked word-log: A finalizing leaves B's lookup attributed to B",
	);

	// --- Learner identity ----------------------------------------------------
	assert.equal(
		requireLearnerId({
			headers: { cookie: `theme=dark; learner_id=${learner}` },
		} as never),
		learner,
	);
	for (const cookie of [undefined, "learner_id=../../etc", "learner_id="]) {
		assert.throws(
			() => requireLearnerId({ headers: { cookie } } as never),
			/no learner id/,
		);
	}
	assert.throws(() => learnerStateDir("../outside"), /Invalid learner id/);
	console.log("checked learner identity: cookie ids are validated");

	// --- Finish-evidence record: complete evidence and idempotence ------------
	const bare = await readFinishEvidence(storyA);
	assert.deepEqual(bare, { storyId: storyA }, "unknown story → bare record");

	await updateFinishEvidence(storyA, {
		finalizedAt: "2026-07-16T00:00:00.000Z",
		storySummary: "a summary",
		learnerQuestions: ["What does hundo mean?"],
		recapResults: [
			{ type: "word-connect", label: "hundo = hundred", attempts: 1 },
		],
		difficulty: "right",
		wordLookups: [{ word: "hundo", count: 2 }],
		globalWordLookups: [{ word: "libro", count: 1 }],
	});
	// A repeated finalization must retain the complete original evidence.
	const merged = await updateFinishEvidence(storyA, {
		learnerQuestions: ["What does hundo mean?", "Why is it hundo?"],
		difficulty: "bitHard",
	});
	assert.equal(merged.finalizedAt, "2026-07-16T00:00:00.000Z");
	assert.deepEqual(merged.learnerQuestions, [
		"What does hundo mean?",
		"Why is it hundo?",
	]);
	assert.equal(merged.difficulty, "bitHard");
	assert.deepEqual(merged.recapResults, [
		{ type: "word-connect", label: "hundo = hundred", attempts: 1 },
	]);
	assert.equal(merged.storySummary, "a summary");
	assert.deepEqual(merged.wordLookups, [{ word: "hundo", count: 2 }]);
	assert.deepEqual(merged.globalWordLookups, [{ word: "libro", count: 1 }]);

	const reread = await readFinishEvidence(storyA);
	assert.deepEqual(reread, merged, "the merged record persists to disk");
	console.log("checked finish-evidence: updates merge and persist");

	// Concurrent updates to the same story serialize instead of clobbering.
	await Promise.all([
		updateFinishEvidence(storyB, { finalizedAt: "t1" }),
		updateFinishEvidence(storyB, {
			learnerQuestions: ["late question"],
			difficulty: "right",
		}),
	]);
	const bRecord = await readFinishEvidence(storyB);
	assert.equal(bRecord.finalizedAt, "t1");
	assert.deepEqual(bRecord.learnerQuestions, ["late question"]);
	assert.equal(bRecord.difficulty, "right");
	console.log(
		"checked finish-evidence: concurrent updates to one story serialize",
	);

	// --- Structured learner state: strict, bounded, and atomic --------------
	assert.equal(
		parseLearnerContext({
			preferences: DEFAULT_LEARNER_PREFERENCES,
			storyMemory,
			extra: true,
		}),
		null,
		"the canonical state rejects extra top-level fields",
	);
	console.log("checked learner state: schemas are strict and bounded");

	const fifoMemory = {
		...storyMemory,
		recentStories: Array.from({ length: 5 }, (_, index) => ({
			genreId: "esperanto" as const,
			motif: `motif ${index}`,
			protagonist: `protagonist ${index}`,
			setting: `setting ${index}`,
			elements: [`element ${index}`],
		})),
	};
	const mergedMemory = mergeStoryMemory(
		fifoMemory,
		{
			genreId: "esperanto",
			motif: "new motif",
			protagonist: "new protagonist",
			setting: "new setting",
			elements: ["new element"],
		},
		"2026-07-17",
	);
	assert.deepEqual(
		mergedMemory.recentStories.map((story) => story.motif),
		["new motif", "motif 0", "motif 1", "motif 2", "motif 3"],
	);
	assert.ok(
		!mergedMemory.recentStories.some((story) => story.motif === "motif 4"),
	);
	console.log(
		"checked story memory: newest-first FIFO eviction is deterministic",
	);

	// --- Service-level finalization -----------------------------------------
	process.env.OPENAI_API_KEY = "test-key";
	await writeLearnerContext(learner, {
		preferences: DEFAULT_LEARNER_PREFERENCES,
		storyMemory,
	});
	let refinementCalls = 0;
	const fakeOpenai = {
		chat: {
			completions: {
				create: async () => {
					refinementCalls += 1;
					const output = {
						themeSuggestion: "seaside",
						narrativeScale: "simple",
						language: {
							focus: "Naming actions with the -ado suffix",
							progression: "advance",
							complexity: "similar",
							calibrationSnippets: ["La lernanto trankvile vizitas laborejon."],
						},
						recentStory: {
							motif: "finding a missing workshop tool",
							protagonist: "adult learner",
							setting: "quiet workshop",
							elements: ["missing tool", "work table"],
						},
					};
					return {
						choices: [
							{
								message: { content: JSON.stringify(output) },
							},
						],
					};
				},
			},
		},
	} as never;
	const evidence = {
		genreId: "esperanto" as const,
		storyId: storyC,
		storySummary: "A learner visits a quiet workshop.",
		storyParts: [
			"La lernanto vizitas laborejon.",
			"Ŝi vidas ilojn sur tablo.",
			"Unu ilo mankas.",
			"Ŝi serĉas ĝin.",
			"Ŝi trovas la ilon.",
			"La laboro povas komenciĝi.",
		],
		languageFocus: "Naming tools with the -ilo suffix",
		generationBrief: {
			themeSuggestion: "",
			narrativeScale: "simple" as const,
			language: {
				focus: "Naming tools with the -ilo suffix",
				progression: "advance" as const,
				complexity: "similar" as const,
				calibrationSnippets: ["La lernanto vizitas laborejon."],
			},
		},
		learnerQuestions: ["What does ilo mean?"],
		recapResults: [{ type: "word-connect", label: "ilo = tool", attempts: 1 }],
		difficulty: "right" as const,
		practiceRequest: "the -ilo suffix kept slipping",
	};
	await finalizeStoryEvidence(fakeOpenai, learner, evidence, "");
	assert.equal(
		refinementCalls,
		1,
		"first finalization produces one next-story brief",
	);
	const firstRecord = await readFinishEvidence(storyC);
	assert.ok(firstRecord.finalizedAt);
	assert.deepEqual(firstRecord.learnerQuestions, evidence.learnerQuestions);
	assert.deepEqual(firstRecord.recapResults, evidence.recapResults);
	assert.equal(firstRecord.difficulty, "right");
	assert.equal(firstRecord.practiceRequest, "the -ilo suffix kept slipping");
	// Calibration examples may lightly paraphrase the story; only their schema and
	// presence are required for the handoff to remain usable.
	// The producer's self-contained brief is stored in the reading-lifecycle
	// record, keyed by this story, for the next prepare to read via basedOnStoryId.
	assert.deepEqual(firstRecord.nextStoryBrief, {
		themeSuggestion: "seaside",
		narrativeScale: "simple",
		language: {
			focus: "Naming actions with the -ado suffix",
			progression: "advance",
			complexity: "similar",
			calibrationSnippets: ["La lernanto trankvile vizitas laborejon."],
		},
	});
	assert.deepEqual(
		await readLearnerContext(otherLearner),
		await (async () => {
			const { DEFAULT_LEARNER_CONTEXT } = await import(
				"../src/learnerState.ts"
			);
			return DEFAULT_LEARNER_CONTEXT;
		})(),
		"finalizing one learner's story leaves another learner's state untouched",
	);
	const contextAfterFinalization = await readLearnerContext(learner);
	assert.deepEqual(contextAfterFinalization.storyMemory.recentStories[0], {
		genreId: "esperanto",
		motif: "finding a missing workshop tool",
		protagonist: "adult learner",
		setting: "quiet workshop",
		elements: ["missing tool", "work table"],
	});
	assert.deepEqual(contextAfterFinalization.storyMemory.recentStories[1], {
		...storyMemory.recentStories[0],
	});

	await finalizeStoryEvidence(fakeOpenai, learner, evidence, "");
	assert.equal(refinementCalls, 1, "identical finalization is a no-op");
	// Late evidence is intentionally ignored once a story has finalized: feedback
	// is resolved exactly once, when the next story is generated, so a reopened
	// story cannot replace the already-bound handoff.
	await finalizeStoryEvidence(
		fakeOpenai,
		learner,
		{
			...evidence,
			learnerQuestions: [...evidence.learnerQuestions, "Why ilo?"],
			difficulty: "tooHard" as const,
		},
		"",
	);
	assert.equal(
		refinementCalls,
		1,
		"late evidence after finalization does not re-refine",
	);
	const afterLate = await readFinishEvidence(storyC);
	assert.deepEqual(
		afterLate.learnerQuestions,
		evidence.learnerQuestions,
		"the finalized record is not mutated by late evidence",
	);
	assert.equal(afterLate.difficulty, "right");

	const contextBeforeRecovery = await readLearnerContext(learner);
	const malformedOpenai = {
		chat: {
			completions: {
				create: async () => ({
					choices: [{ message: { content: "{malformed" } }],
				}),
			},
		},
	} as never;
	const generationBrief = {
		themeSuggestion: "coastal journey",
		narrativeScale: "simple" as const,
		language: {
			focus: "Past-tense travel actions",
			progression: "advance" as const,
			complexity: "harder" as const,
			calibrationSnippets: ["La vojaĝanto atingis la havenon."],
		},
	};
	await finalizeStoryEvidence(
		malformedOpenai,
		learner,
		{
			...evidence,
			storyId: storyD,
			languageFocus: generationBrief.language.focus,
			generationBrief,
			difficulty: "tooHard" as const,
		},
		"",
	);
	const recoveredRecord = await readFinishEvidence(storyD);
	assert.deepEqual(recoveredRecord.nextStoryBrief, {
		themeSuggestion: "",
		// "Too hard" shrinks the prior simple scale, with or without the model.
		narrativeScale: "minimal",
		language: {
			focus: "Past-tense travel actions",
			progression: "reinforce",
			complexity: "simpler",
			calibrationSnippets: [evidence.storyParts[0]],
		},
	});
	assert.deepEqual(
		(await readLearnerContext(learner)).storyMemory,
		contextBeforeRecovery.storyMemory,
		"malformed handoff keeps the existing FIFO unchanged",
	);
	console.log(
		"checked finalization recovery: rating applies to the prior scale",
	);
	console.log(
		"checked finalization service: full evidence, idempotence, no late deltas",
	);

	// The rating, not the model, owns how much the next story may grow.
	const handoffOpenai = (complexity: string) =>
		({
			chat: {
				completions: {
					create: async () => ({
						choices: [
							{
								message: {
									content: JSON.stringify({
										themeSuggestion: "",
										narrativeScale: "simple",
										language: {
											focus: "Accusative -n",
											progression: "reinforce",
											complexity,
											calibrationSnippets: ["Niko vidas la ŝlosilon."],
										},
									}),
								},
							},
						],
					}),
				},
			},
		}) as never;
	const minimalBrief = {
		...generationBrief,
		narrativeScale: "minimal" as const,
	};
	for (const [storyId, proposed, expected] of [
		["esperanto--story-e--0005", "harder", "similar"],
		["esperanto--story-f--0006", "simpler", "simpler"],
	] as const) {
		await finalizeStoryEvidence(
			handoffOpenai(proposed),
			learner,
			{
				...evidence,
				storyId,
				generationBrief: minimalBrief,
				difficulty: "right" as const,
			},
			"",
		);
		const brief = (await readFinishEvidence(storyId)).nextStoryBrief;
		assert.equal(brief?.narrativeScale, "minimal", "right keeps the scale");
		assert.equal(brief?.language.complexity, expected);
	}
	console.log(
		"checked finalization handoff: rating bounds scale and complexity",
	);

	console.log("\nstory-finish evidence checks passed");
} finally {
	process.chdir(originalCwd);
	await rm(workDir, { recursive: true, force: true });
}
