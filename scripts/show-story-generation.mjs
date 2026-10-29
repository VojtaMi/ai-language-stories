/**
 * Prints how a reading story was generated, from the `generation.json` kept
 * beside its media: the brief it was written for, the plot before and after
 * review, the draft manuscript, every logic-check and proofreading edit
 * (proposed and applied), the final parts, and the planned image scenes.
 *
 *   node scripts/show-story-generation.mjs <story-id | story folder>...
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const targets = process.argv.slice(2);
if (targets.length === 0) {
	console.error(
		"Usage: node scripts/show-story-generation.mjs <story-id | story folder>...",
	);
	process.exit(2);
}

for (const target of targets) {
	const folder = target.includes("/")
		? target
		: join("stories", target.split("--")[0], target);
	const log = JSON.parse(
		await readFile(join(folder, "generation.json"), "utf8"),
	);
	const { story } = log;
	const brief = story.generationBrief;
	print(`# ${story.title}  (${folder})`);
	print(
		`brief: ${brief.narrativeScale}, ${brief.language.complexity}, ${brief.language.progression}; theme "${brief.themeSuggestion}"`,
	);
	print(`focus: ${brief.language.focus}`);
	print(`calibration: ${brief.language.calibrationSnippets.join(" | ")}`);
	print(
		`\n## Plot${log.plotRevised ? " (revised by review)" : " (review: OK)"}`,
	);
	if (log.plotRevised) print(`draft: ${log.plotDraft}\n`);
	print(log.plot);
	print(`\n## Draft manuscript\n${log.draftText}`);
	for (const pass of ["logicCheck", "proofread"]) {
		const review = log[pass];
		const applied = new Set(review.applied.map((edit) => edit.original));
		print(
			`\n## ${pass}: ${review.proposed.length} proposed, ${review.applied.length} applied${review.error ? `, failed: ${review.error}` : ""}`,
		);
		for (const edit of review.proposed) {
			print(
				`${applied.has(edit.original.trim()) ? "applied" : "DROPPED"}: ${edit.original}`,
			);
			print(
				`      -> ${edit.corrected}${edit.reason ? `  (${edit.reason})` : ""}`,
			);
		}
	}
	print("\n## Parts");
	story.parts.forEach((part, index) => {
		print(
			`${index + 1}. [${part.text.split(/\s+/).length} words] ${part.text}`,
		);
	});
	print("\n## Image scenes");
	for (const scene of story.imageScenes) {
		print(`- [${scene.visible.join(", ")}] ${scene.prompt}`);
	}
	print("");
}

function print(line) {
	console.log(line);
}
