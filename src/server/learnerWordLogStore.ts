import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { learnerStateDir } from "./learnerScope";

export interface LearnerWordLogEntry {
	word: string;
	timestamp: string;
	/**
	 * The story the lookup happened in. Its finalization folds exactly these
	 * lookups, so a delayed finalization can't consume another story's lookups.
	 */
	storyId?: string;
}

const MAX_WORD_LOOKUP_SUMMARY = 20;

let writeQueue: Promise<void> = Promise.resolve();

function wordLogPath(learnerId: string) {
	return join(learnerStateDir(learnerId), "word-log.json");
}

async function readWordLog(learnerId: string): Promise<LearnerWordLogEntry[]> {
	try {
		const parsed = JSON.parse(
			await readFile(wordLogPath(learnerId), "utf8"),
		) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isLearnerWordLogEntry);
	} catch {
		return [];
	}
}

async function writeWordLog(
	learnerId: string,
	log: LearnerWordLogEntry[],
): Promise<void> {
	await mkdir(learnerStateDir(learnerId), { recursive: true });
	await writeFile(
		wordLogPath(learnerId),
		`${JSON.stringify(log, null, 2)}\n`,
		"utf8",
	);
}

export async function appendLearnerWordLogEntry(
	learnerId: string,
	word: string,
	storyId?: string,
): Promise<void> {
	writeQueue = writeQueue
		.catch(() => undefined)
		.then(async () => {
			const log = await readWordLog(learnerId);
			log.push({
				word,
				timestamp: new Date().toISOString(),
				...(storyId ? { storyId } : {}),
			});
			await writeWordLog(learnerId, log);
		});
	return writeQueue;
}

/** One word looked up, and how many times, formatted for both prompt and audit. */
export interface AggregatedLookups {
	/** Prompt-ready lines, repeats first: e.g. `hundo (3x)`. */
	lookups: string[];
	/** Structured counts for the finalization record's audit trail. */
	aggregated: { word: string; count: number }[];
}

function aggregate(entries: LearnerWordLogEntry[]): AggregatedLookups {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		counts.set(entry.word, (counts.get(entry.word) ?? 0) + 1);
	}
	const sorted = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_WORD_LOOKUP_SUMMARY);
	return {
		lookups: sorted.map(([word, count]) => `${word} (${count}x)`),
		aggregated: sorted.map(([word, count]) => ({ word, count })),
	};
}

/**
 * Aggregates the word lookups that happened during one specific reading story.
 * Used by that story's baseline finalization, which runs at most once (guarded
 * by the finish-evidence record), so this story's lookups can never be
 * attributed to another story.
 */
export async function readWordLookupsForStory(
	learnerId: string,
	storyId: string,
): Promise<AggregatedLookups> {
	const log = await readWordLog(learnerId);
	return aggregate(log.filter((entry) => entry.storyId === storyId));
}

/**
 * Removes one story's scoped entries from the log once its baseline has folded
 * them in. Hygiene only: correctness comes from the baseline running once, not
 * from pruning. Unscoped entries and other stories' entries are left untouched.
 */
export async function pruneWordLogForStory(
	learnerId: string,
	storyId: string,
): Promise<void> {
	writeQueue = writeQueue
		.catch(() => undefined)
		.then(async () => {
			const log = await readWordLog(learnerId);
			const kept = log.filter((entry) => entry.storyId !== storyId);
			if (kept.length !== log.length) await writeWordLog(learnerId, kept);
		});
	return writeQueue;
}

function isLearnerWordLogEntry(value: unknown): value is LearnerWordLogEntry {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as LearnerWordLogEntry).word !== "string" ||
		typeof (value as LearnerWordLogEntry).timestamp !== "string"
	) {
		return false;
	}
	const storyId = (value as LearnerWordLogEntry).storyId;
	return storyId === undefined || typeof storyId === "string";
}
