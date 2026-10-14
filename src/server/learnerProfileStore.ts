import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	DEFAULT_LEARNER_CONTEXT,
	type LearnerContext,
	parseLearnerContext,
} from "../learnerState";
import { learnerStateDir } from "./learnerScope";

function statePath(learnerId: string) {
	return join(learnerStateDir(learnerId), "state.json");
}

export async function readLearnerContext(
	learnerId: string,
): Promise<LearnerContext> {
	try {
		const raw = await readFile(statePath(learnerId), "utf8");
		const parsed = parseLearnerContext(JSON.parse(raw));
		if (parsed) return parsed;
		console.warn("Ignoring invalid learner state; using default state.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn("Could not read learner state; using default state.", error);
		}
	}
	return structuredClone(DEFAULT_LEARNER_CONTEXT);
}

export async function writeLearnerContext(
	learnerId: string,
	context: LearnerContext,
): Promise<void> {
	const valid = parseLearnerContext(context);
	if (!valid) throw new Error("Refusing to write invalid learner state.");
	const path = statePath(learnerId);
	await mkdir(learnerStateDir(learnerId), { recursive: true });
	await writeFile(`${path}.tmp`, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
	await rename(`${path}.tmp`, path);
}
