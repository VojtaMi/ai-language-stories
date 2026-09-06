import assert from "node:assert/strict";

/**
 * The reading-story lifecycle exists to enforce one ordering: the next story is
 * never generated until the finished story's evidence has landed. A story
 * prepared too early misses the self-contained handoff its predecessor was
 * about to produce.
 *
 * `runReadingPreparation` is the pass that carries the ordering, taking its
 * effects as arguments, so these assert the property directly — no React, no
 * provider.
 */
const {
	runReadingPreparation,
	runInitialReadingPreparation,
	decideReadingPreparationOnLoad,
	isReadingPreparationBusy,
	isPendingEvidenceStaleWhileBlocked,
	readingPreparationErrorMessage,
} = await import("../src/story_session/useReadingPreparation.ts");
const { OpeningRequestError } = await import("../src/openings.ts");

type Status = string;

function recorder() {
	const statuses: Status[] = [];
	return { statuses, setStatus: (status: Status) => statuses.push(status) };
}

/** Silence the lifecycle's expected warnings while asserting failure paths. */
async function withoutWarnings<T>(run: () => Promise<T>): Promise<T> {
	const original = console.warn;
	console.warn = () => {};
	try {
		return await run();
	} finally {
		console.warn = original;
	}
}

async function checkFinalizationOrdering() {
	// The ordering itself: preparation must not start while finalization is
	// still in flight, however long finalization takes.
	const { statuses, setStatus } = recorder();
	let finalized = false;
	let preparedWhileFinalizing = false;

	await runReadingPreparation({
		finalize: async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			finalized = true;
		},
		prepare: async () => {
			if (!finalized) preparedWhileFinalizing = true;
			return { length: 1 };
		},
		setStatus,
	});

	assert.equal(
		preparedWhileFinalizing,
		false,
		"preparation started before finalization resolved",
	);
	assert.deepEqual(statuses, ["finalizing", "preparing", "ready"]);
	console.log("checked reading preparation: finalization precedes generation");
}
await checkFinalizationOrdering();

async function checkSettledStatus() {
	// The settled status is what tells the caller whether the persisted evidence
	// can be dropped. Reporting "ready" for a lifecycle that failed would discard
	// the evidence a resume needs, stranding the next story for good.
	const settledReady = await runReadingPreparation({
		finalize: async () => {},
		prepare: async () => ({ length: 1 }),
		setStatus: () => {},
	});
	assert.equal(settledReady, "ready");

	const settledError = await withoutWarnings(() =>
		runReadingPreparation({
			finalize: () => Promise.reject(new Error("finalize failed")),
			prepare: async () => ({ length: 1 }),
			setStatus: () => {},
		}),
	);
	assert.equal(settledError, "error");
	console.log(
		"checked reading preparation: settled status reports the outcome",
	);
}
await checkSettledStatus();

{
	// A failed finalization must not fall through to generation: the next story
	// would be built from exactly the stale state finalization was fixing.
	const { statuses, setStatus } = recorder();
	let prepareCalls = 0;

	await withoutWarnings(() =>
		runReadingPreparation({
			finalize: () => Promise.reject(new Error("finalize failed")),
			prepare: async () => {
				prepareCalls += 1;
				return { length: 1 };
			},
			setStatus,
		}),
	);

	assert.equal(
		prepareCalls,
		0,
		"generated a story despite failed finalization",
	);
	assert.deepEqual(statuses, ["finalizing", "error"]);
	console.log(
		"checked reading preparation: failed finalization blocks generation",
	);
}

{
	// A failed preparation must surface retry rather than strand the button.
	const { statuses, setStatus } = recorder();
	const errors: Array<string | null> = [];

	await withoutWarnings(() =>
		runReadingPreparation({
			finalize: async () => {},
			prepare: () =>
				Promise.reject(
					new OpeningRequestError(
						"Daily story limit reached. Please try again later.",
						429,
						"story_daily_limit",
						3600,
					),
				),
			setStatus,
			setError: (message: string | null) => errors.push(message),
		}),
	);

	assert.deepEqual(statuses, ["finalizing", "preparing", "error"]);
	assert.equal(
		errors.at(-1),
		"Daily story limit reached. Please try again later.",
	);
	console.log(
		"checked reading preparation: failed generation offers retry and its message",
	);
}

assert.equal(
	readingPreparationErrorMessage(
		new OpeningRequestError(
			"Too many AI requests. Please wait a minute and try again.",
			429,
			"ai_burst_limit",
			60,
		),
	),
	"Too many AI requests. Please wait a minute and try again.",
);
assert.equal(
	readingPreparationErrorMessage(new Error("provider internals")),
	"Could not prepare the reading story. Please try again.",
);

{
	// Preparation that reports an empty queue is a failure too — "ready" would
	// promise a story the menu cannot consume.
	const { statuses, setStatus } = recorder();

	await runReadingPreparation({
		finalize: async () => {},
		prepare: async () => ({ length: 0 }),
		setStatus,
	});

	assert.deepEqual(statuses, ["finalizing", "preparing", "error"]);
	console.log("checked reading preparation: an empty queue is not ready");
}

async function checkReloadDecisions() {
	// Reload while the next story is being made. The lifecycle lives in the page,
	// so nothing survives to finish it: the load must pick it back up.
	assert.equal(
		decideReadingPreparationOnLoad({
			hasUnfinishedSave: false,
			preparedCount: 0,
			hasPendingEvidence: true,
		}),
		"resume",
		"a reload mid-lifecycle left the next story with nobody preparing it",
	);

	// Enabling the button here would let the learner start a story generated
	// outside the lifecycle, racing the finalization it is meant to follow.
	assert.notEqual(
		decideReadingPreparationOnLoad({
			hasUnfinishedSave: false,
			preparedCount: 0,
			hasPendingEvidence: true,
		}),
		"idle",
	);

	// A queued story means the lifecycle completed; the leftover evidence is
	// stale and must not re-run anything.
	assert.equal(
		decideReadingPreparationOnLoad({
			hasUnfinishedSave: false,
			preparedCount: 1,
			hasPendingEvidence: true,
		}),
		"ready",
	);

	// Nothing finished, nothing queued: an empty initial queue (a fresh install,
	// or every reading story and the queue having been cleared) must start
	// preparation, not sit idle with an enabled button and no story behind it.
	assert.equal(
		decideReadingPreparationOnLoad({
			hasUnfinishedSave: false,
			preparedCount: 0,
			hasPendingEvidence: false,
		}),
		"initial",
	);
	assert.notEqual(
		decideReadingPreparationOnLoad({
			hasUnfinishedSave: false,
			preparedCount: 0,
			hasPendingEvidence: false,
		}),
		"idle",
		"an empty initial queue must not be reported as idle",
	);

	assert.equal(
		decideReadingPreparationOnLoad({
			hasUnfinishedSave: false,
			preparedCount: 1,
			hasPendingEvidence: false,
		}),
		"ready",
	);
	console.log("checked reading preparation: a reload resumes a dead lifecycle");
}
await checkReloadDecisions();

function checkUnfinishedSaveDecision() {
	// An unfinished reading story means the state isn't blank: resuming it is
	// the only next step, however full the queue or pending evidence looks.
	// Preparing a fresh one here — even the very first story — would silently
	// abandon a story the learner never finished.
	assert.equal(
		decideReadingPreparationOnLoad({
			hasUnfinishedSave: true,
			preparedCount: 0,
			hasPendingEvidence: false,
		}),
		"blocked",
	);
	assert.equal(
		decideReadingPreparationOnLoad({
			hasUnfinishedSave: true,
			preparedCount: 1,
			hasPendingEvidence: true,
		}),
		"blocked",
		"an unfinished save must take priority over a queued or pending story",
	);
	assert.equal(
		isReadingPreparationBusy("idle"),
		false,
		"the 'idle' status a blocked decision leads to would not itself disable the button — the caller resumes instead of starting fresh",
	);
	console.log(
		"checked reading preparation: an unfinished save blocks preparation",
	);
}
checkUnfinishedSaveDecision();

function checkPendingEvidenceDecision() {
	// Regression: finishing a story and immediately leaving to the menu writes
	// its "finished" phase in a separate, unawaited persist from the one that
	// records pending finalization evidence. A reload landing between the two
	// sees the just-finished story as "unfinished" (the phase write lost the
	// race) while its own evidence — written synchronously, before either
	// network call — is still sitting there. That evidence is not stale: it is
	// this exact lifecycle, not a superseded one, and discarding it would force
	// the learner to redo a recap they already completed.
	assert.equal(
		isPendingEvidenceStaleWhileBlocked("story-a", "story-a"),
		false,
		"evidence for the very story reported unfinished must survive a blocked decision",
	);

	// Evidence left over from a different, already-superseded lifecycle is
	// exactly the case this exists to catch — that one is safe to discard.
	assert.equal(
		isPendingEvidenceStaleWhileBlocked("story-a", "story-b"),
		true,
		"evidence naming a different story than the one blocking must be discarded",
	);

	// No pending evidence at all is not stale evidence — nothing to discard.
	assert.equal(isPendingEvidenceStaleWhileBlocked(null, "story-b"), false);

	console.log(
		"checked reading preparation: pending evidence for the blocking story survives a reload",
	);
}
checkPendingEvidenceDecision();

{
	// The very first reading story has no previous story to finalize, so the
	// initial pass must skip straight to `preparing` — never `finalizing`.
	const { statuses, setStatus } = recorder();

	const settled = await runInitialReadingPreparation({
		prepare: async () => ({ length: 1 }),
		setStatus,
	});

	assert.equal(settled, "ready");
	assert.deepEqual(statuses, ["preparing", "ready"]);
	console.log(
		"checked reading preparation: initial preparation skips finalizing",
	);
}

{
	// An empty result from the initial pass is a failure too, exactly like the
	// finalize-first lifecycle — "ready" would promise a story the menu cannot
	// consume.
	const { statuses, setStatus } = recorder();

	const settled = await runInitialReadingPreparation({
		prepare: async () => ({ length: 0 }),
		setStatus,
	});

	assert.equal(settled, "error");
	assert.deepEqual(statuses, ["preparing", "error"]);
	console.log(
		"checked reading preparation: an empty initial queue is not ready",
	);
}

{
	// The button-disabled property the menu relies on: the empty-initial-queue
	// decision must land on a status that reports busy, so the "Reading Story"
	// button is disabled instead of falling through to a direct-generation
	// fallback.
	const decision = decideReadingPreparationOnLoad({
		preparedCount: 0,
		hasPendingEvidence: false,
	});
	assert.equal(decision, "initial");
	assert.equal(
		isReadingPreparationBusy("preparing"),
		true,
		"the status an initial decision leads to must disable the button",
	);
	assert.equal(
		isReadingPreparationBusy("idle"),
		false,
		"idle does not disable the button, which is exactly why an empty initial queue must not resolve to idle",
	);
	console.log(
		"checked reading preparation: an empty initial queue disables the Reading Story button",
	);
}

console.log("reading preparation checks passed");
