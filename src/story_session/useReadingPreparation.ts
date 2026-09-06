import { useCallback, useEffect, useRef, useState } from "react";
import { finalizeReadingStoryEvidence, type StoryFinishEvidence } from "../ai";
import type { LanguageId } from "../languages";
import { readSelectedNarrationModel } from "../modelSelection/modelSelectionStore";
import type { StoryGenerationPreset } from "../models";
import {
	listPreparedReadingOpenings,
	OpeningRequestError,
	prepareMissingReadingOpenings,
} from "../openings";
import { findUnfinishedReadingSave, listSavedStories } from "../saves";
import {
	clearPendingReadingEvidence,
	readPendingReadingEvidence,
	readPendingReadingTheme,
	savePendingReadingEvidence,
	savePendingReadingTheme,
} from "./readingPreparationStore";

/**
 * Where the next reading story stands:
 *
 *     idle → finalizing → preparing → ready
 *                    └────────┴─────→ error
 *
 * The order is the point. `finalizing` folds the finished story's evidence into
 * the learner baseline and story memory; `preparing` only starts once that has
 * landed, so the next story is generated against the state the finished story
 * produced rather than the state it replaced. A story prepared too early sees
 * the previous story's memory and repeats its premise.
 *
 * The very first story — nothing finished yet, so nothing to finalize — skips
 * straight from `idle` to `preparing`. See `runInitialReadingPreparation`.
 */
export type ReadingPreparationStatus =
	| "idle"
	| "finalizing"
	| "preparing"
	| "ready"
	| "error";

interface ReadingPreparationRun {
	finalize: () => Promise<void>;
	/** Resolves with how many stories are queued once preparation has run. */
	prepare: () => Promise<{ length: number }>;
	setStatus: (status: ReadingPreparationStatus) => void;
	setError?: (message: string | null) => void;
}

export function readingPreparationErrorMessage(error: unknown) {
	if (
		error instanceof OpeningRequestError &&
		(error.code === "story_daily_limit" || error.code === "ai_burst_limit")
	) {
		return error.message;
	}
	return "Could not prepare the reading story. Please try again.";
}

/** The `preparing` step shared by the finalize-first and initial passes. */
async function prepareAndSettle(
	prepare: () => Promise<{ length: number }>,
	setStatus: (status: ReadingPreparationStatus) => void,
	warning: string,
	setError?: (message: string | null) => void,
): Promise<"ready" | "error"> {
	setError?.(null);
	setStatus("preparing");
	try {
		const prepared = await prepare();
		const settled = prepared.length > 0 ? "ready" : "error";
		setStatus(settled);
		return settled;
	} catch (err) {
		console.warn(warning, err);
		setError?.(readingPreparationErrorMessage(err));
		setStatus("error");
		return "error";
	}
}

/**
 * One pass of the lifecycle, resolving with the status it settled on.
 * Extracted from the hook so the ordering it exists to guarantee — `prepare` is
 * never entered until `finalize` has resolved — is assertable without rendering.
 */
export async function runReadingPreparation({
	finalize,
	prepare,
	setStatus,
	setError,
}: ReadingPreparationRun): Promise<"ready" | "error"> {
	setError?.(null);
	setStatus("finalizing");
	try {
		await finalize();
	} catch (err) {
		// Preparing anyway would generate the next story from the state
		// finalization was meant to update — the exact repetition this lifecycle
		// exists to prevent. Surface a retry instead.
		console.warn("Could not finalize reading story evidence.", err);
		setError?.("Could not finalize the finished story. Please try again.");
		setStatus("error");
		return "error";
	}
	return prepareAndSettle(
		prepare,
		setStatus,
		"Could not prepare the next reading story.",
		setError,
	);
}

/**
 * The very first reading story, prepared before any story has been finished.
 * There is no previous story's evidence to fold in, so this skips
 * `finalizing` entirely and goes straight to `preparing`.
 */
export async function runInitialReadingPreparation({
	prepare,
	setStatus,
	setError,
}: {
	prepare: () => Promise<{ length: number }>;
	setStatus: (status: ReadingPreparationStatus) => void;
	setError?: (message: string | null) => void;
}): Promise<"ready" | "error"> {
	return prepareAndSettle(
		prepare,
		setStatus,
		"Could not prepare the first reading story.",
		setError,
	);
}

/**
 * What a fresh page load (or a fresh menu visit) should do about the next
 * reading story, given whether one is already unfinished, the durable queue,
 * and any evidence a previous page left behind.
 *
 * `blocked` takes priority over everything else. An unfinished reading story
 * means the state isn't blank: resuming it is the only next step, and
 * preparing — even the very first story — must wait until it is finished. This
 * is what stops an abandoned, never-finished story from silently getting a
 * fresh replacement prepared behind it.
 *
 * `resume` is the next load-bearing case. The lifecycle runs in the page and
 * only starts preparation once finalization resolves, so a reload in between
 * leaves evidence with nobody acting on it. Answering `idle` there would
 * enable the button over an empty queue, and starting a story would generate
 * one outside the lifecycle, racing the finalization it is meant to follow.
 * Answering `preparing` without acting would disable the button forever, since
 * nothing else will ever fill the queue.
 *
 * `initial` is the same "nothing to act on yet" shape, but with no previous
 * story at all — a fresh install, or every reading story and the queue having
 * been cleared. Answering `idle` there enables the button over an empty queue
 * exactly like the `resume` case, except with nothing to resume: the caller
 * must start an initial (finalize-skipping) preparation instead.
 */
export function decideReadingPreparationOnLoad({
	hasUnfinishedSave,
	preparedCount,
	hasPendingEvidence,
}: {
	hasUnfinishedSave: boolean;
	preparedCount: number;
	hasPendingEvidence: boolean;
}): "blocked" | "ready" | "resume" | "initial" {
	if (hasUnfinishedSave) return "blocked";
	// A queued story means the lifecycle got there, whoever finished it.
	if (preparedCount > 0) return "ready";
	if (hasPendingEvidence) return "resume";
	return "initial";
}

/**
 * Whether pending finalization evidence should be discarded while blocked on
 * an unfinished reading story.
 *
 * Evidence for exactly that story is still legitimate, not stale: the phase
 * that marks a save "finished" is persisted separately from — and after —
 * `savePendingReadingEvidence`, so a reload between the two (finalize already
 * under way, the "finished" write never landing before the page closed) sees
 * the story as unfinished while its own evidence is still good. Only evidence
 * naming some other, already-superseded story is safe to discard.
 */
export function isPendingEvidenceStaleWhileBlocked(
	pendingStoryId: string | null,
	unfinishedSaveId: string | null,
): boolean {
	return pendingStoryId !== null && pendingStoryId !== unfinishedSaveId;
}

/** No reading story can start while the next one is being made. */
export function isReadingPreparationBusy(
	status: ReadingPreparationStatus,
): boolean {
	return status === "finalizing" || status === "preparing";
}

export interface ReadingPreparation {
	status: ReadingPreparationStatus;
	error: string | null;
	/** No reading story can start while the next one is being made. */
	busy: boolean;
	/**
	 * Finalize the just-finished story, then prepare exactly one next story.
	 * Calls naming a story that already owns the lifecycle are ignored.
	 */
	makeNextStory: (evidence: StoryFinishEvidence, nextTheme?: string) => void;
	/**
	 * Re-run a lifecycle that failed. Finalization is idempotent server-side.
	 * With no evidence to finalize — nothing pending, no story ever finished —
	 * this instead (re)runs the finalize-skipping initial preparation.
	 */
	retry: () => void;
	/** Report that the prepared story has been taken off the queue. */
	markConsumed: () => void;
}

/**
 * Owns the make-the-next-reading-story lifecycle for the menu boundary. Nothing
 * here runs on menu entry just because the menu is up: a reading story is
 * prepared only as the consequence of finishing one (or, for the very first
 * story, of the state being genuinely blank), so the queue holds at most the
 * story the learner earned.
 *
 * `unfinishedReadingSaveId` is the id of a reading-story save that hasn't
 * reached "finished" yet, if one exists — the caller derives it from the
 * saved-story list. Its presence means the state isn't blank: resuming that
 * story is the only next step, and preparing must wait until it is finished.
 * It is a hint rather than the authority: it also re-runs the decision as the
 * caller's list changes, but an absent id is re-checked against the server
 * before anything is generated.
 * `isMenuVisible` re-runs the decision every time the learner lands back on the
 * menu, since that is the only place a fresh reading story is ever started.
 */
export function useReadingPreparation(
	languageId: LanguageId,
	storyGeneration: StoryGenerationPreset,
	unfinishedReadingSaveId: string | null,
	isMenuVisible: boolean,
): ReadingPreparation {
	// A menu cannot know whether its queue is ready until the first async check
	// completes, so start conservatively busy to avoid an enabled-button flash.
	const [status, setStatus] = useState<ReadingPreparationStatus>("preparing");
	const [error, setError] = useState<string | null>(null);
	const runningRef = useRef(false);
	const runRef = useRef<StoryFinishEvidence | null>(null);
	const storyGenerationRef = useRef(storyGeneration);
	storyGenerationRef.current = storyGeneration;

	const run = useCallback(
		async (evidence: StoryFinishEvidence, nextTheme?: string) => {
			if (runningRef.current) return;
			runningRef.current = true;
			runRef.current = evidence;
			// Written before the work starts, so a reload at any point from here on
			// can pick the lifecycle back up. The theme rides alongside the evidence,
			// never inside it, so finalization never sees it.
			savePendingReadingEvidence(evidence);
			if (nextTheme) savePendingReadingTheme(languageId, nextTheme);
			try {
				const settled = await runReadingPreparation({
					finalize: () => finalizeReadingStoryEvidence(evidence),
					prepare: () =>
						prepareMissingReadingOpenings(
							languageId,
							storyGenerationRef.current,
							evidence.storyId,
							nextTheme,
							readSelectedNarrationModel(),
						),
					setStatus,
					setError,
				});
				// Keep the evidence on `error` — retry, here or after a reload, needs it.
				if (settled === "ready") clearPendingReadingEvidence(languageId);
			} finally {
				runningRef.current = false;
			}
		},
		[languageId],
	);

	const runInitial = useCallback(async () => {
		if (runningRef.current) return;
		runningRef.current = true;
		runRef.current = null;
		try {
			await runInitialReadingPreparation({
				prepare: () =>
					prepareMissingReadingOpenings(
						languageId,
						storyGenerationRef.current,
						null,
						undefined,
						readSelectedNarrationModel(),
					),
				setStatus,
				setError,
			});
		} finally {
			runningRef.current = false;
		}
	}, [languageId]);

	// Readiness comes from the durable queue, not from having watched it fill,
	// and is only ever (re)decided while the learner is on the menu.
	useEffect(() => {
		if (!isMenuVisible || runRef.current) return;

		// The queue check is asynchronous. Keep the start button unavailable while
		// it is in flight; otherwise a fresh menu can briefly show an enabled
		// button, consume nothing, and only then begin the initial preparation.
		setStatus("preparing");
		setError(null);
		let cancelled = false;
		void (async () => {
			const pending = readPendingReadingEvidence(languageId);
			try {
				const [prepared, saves] = await Promise.all([
					listPreparedReadingOpenings(languageId),
					listSavedStories(languageId),
				]);
				// `unfinishedReadingSaveId` is trusted when it names a story and
				// confirmed against the server when it does not. Only the second
				// direction can be wrong in a way that costs money: the caller's list
				// starts empty on a fresh load and is refreshed behind the write that
				// leaving a story issues, so a stale "nothing unfinished" would
				// authorize generating a whole new story on top of one still in
				// progress. Whichever source sees an unfinished story wins.
				const unfinishedSaveId =
					unfinishedReadingSaveId ??
					findUnfinishedReadingSave(saves)?.id ??
					null;
				// A live lifecycle is the better authority — don't let this answer,
				// fetched before it started, overwrite its status.
				if (cancelled || runRef.current) return;
				const decision = decideReadingPreparationOnLoad({
					hasUnfinishedSave: unfinishedSaveId !== null,
					preparedCount: prepared.length,
					hasPendingEvidence: pending !== null,
				});
				if (decision === "blocked") {
					if (
						isPendingEvidenceStaleWhileBlocked(
							pending?.storyId ?? null,
							unfinishedSaveId,
						)
					) {
						clearPendingReadingEvidence(languageId);
					}
					setStatus("idle");
					return;
				}
				if (decision === "resume" && pending) {
					void run(pending, readPendingReadingTheme(languageId) ?? undefined);
					return;
				}
				if (decision === "ready") {
					clearPendingReadingEvidence(languageId);
					setStatus("ready");
					return;
				}
				// decision === "initial": no previous story to finalize, so go
				// straight to preparing the first one.
				void runInitial();
			} catch (err) {
				console.warn("Could not read the prepared reading story queue.", err);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [isMenuVisible, languageId, unfinishedReadingSaveId, run, runInitial]);

	const makeNextStory = useCallback(
		(evidence: StoryFinishEvidence, nextTheme?: string) => {
			// Leaving the story and submitting feedback both finish the same story
			// and both land here; the first caller owns the lifecycle so the pair
			// cannot double-generate.
			if (runRef.current?.storyId === evidence.storyId) return;
			void run(evidence, nextTheme);
		},
		[run],
	);

	const retry = useCallback(() => {
		const pending = runRef.current ?? readPendingReadingEvidence(languageId);
		if (pending) {
			void run(pending, readPendingReadingTheme(languageId) ?? undefined);
			return;
		}
		void runInitial();
	}, [languageId, run, runInitial]);

	const markConsumed = useCallback(() => {
		clearPendingReadingEvidence(languageId);
		runRef.current = null;
		setStatus("idle");
		setError(null);
	}, [languageId]);

	return {
		status,
		error,
		busy: isReadingPreparationBusy(status),
		makeNextStory,
		retry,
		markConsumed,
	};
}
