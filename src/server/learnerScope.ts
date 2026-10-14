import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { isLearnerId, LEARNER_COOKIE, readCookie } from "../learnerIdentity";
import { HttpError } from "./http";

/**
 * Per-learner data lives beneath the directories deployments already persist
 * (`learner/`, `reading-openings/`), one subdirectory per learner id, so
 * scoping it needed no new volume.
 */
const learnerRootDir = join(process.cwd(), "learner");
const readingOpeningsRootDir = join(process.cwd(), "reading-openings");

/** The learner CLI scripts act as: the developer running them. */
export const LOCAL_LEARNER_ID = "local";

function validLearnerId(learnerId: string): string {
	if (learnerId !== LOCAL_LEARNER_ID && !isLearnerId(learnerId)) {
		throw new Error(`Invalid learner id: ${learnerId}`);
	}
	return learnerId;
}

/** Settings, story memory, and word log for one learner. */
export function learnerStateDir(learnerId: string): string {
	return join(learnerRootDir, validLearnerId(learnerId));
}

/** The prepared next story per language for one learner. */
export function learnerReadingOpeningsDir(learnerId: string): string {
	return join(readingOpeningsRootDir, validLearnerId(learnerId));
}

/**
 * The learner a request acts for. Learner endpoints refuse requests without
 * one rather than falling back to shared state, which is what mixed every
 * visitor's adaptation together before.
 */
export function requireLearnerId(req: IncomingMessage): string {
	const learnerId = readCookie(req.headers.cookie, LEARNER_COOKIE);
	if (!isLearnerId(learnerId)) {
		throw new HttpError(
			400,
			"This browser has no learner id. Reload the page to create one.",
		);
	}
	return learnerId;
}
