import assert from "node:assert/strict";
import {
	buildEvaluationCases,
	parseJudgeScore,
	parseTextModelComparisonArgs,
	scoreManuscriptDeterministically,
} from "../scripts/compare-text-models.ts";

const fixedNow = new Date("2026-09-22T10:00:00.000Z");
const smoke = parseTextModelComparisonArgs(["--smoke", "--no-judge"], fixedNow);
assert.deepEqual(smoke.languageIds, ["esperanto"]);
assert.deepEqual(smoke.fixtureIds, ["station-key"]);
assert.equal(smoke.repeats, 1);
assert.equal(smoke.judge, false);
assert.deepEqual(
	smoke.candidates.map(({ id }) => id),
	["gpt-5.6-luna:low", "gpt-6-luna:low", "gpt-6-sol:low"],
);

const configured = parseTextModelComparisonArgs(
	[
		"--candidates",
		"gpt-6-luna:medium,gpt-6-sol:low",
		"--languages",
		"german,spanish",
		"--fixtures",
		"garden-telescope",
		"--repeats",
		"3",
		"--output",
		".artifacts/custom-eval",
	],
	fixedNow,
);
assert.deepEqual(
	configured.candidates.map(({ id }) => id),
	["gpt-6-luna:medium", "gpt-6-sol:low"],
);
assert.deepEqual(configured.languageIds, ["german", "spanish"]);
assert.equal(configured.repeats, 3);
assert.throws(
	() => parseTextModelComparisonArgs(["--candidates", "gpt-6-moon:low"]),
	/Unknown candidate model/,
);
assert.throws(
	() => parseTextModelComparisonArgs(["--languages", "klingon"]),
	/Unknown language/,
);

const [evaluationCase] = buildEvaluationCases(["esperanto"], ["station-key"]);
assert.ok(evaluationCase);
assert.equal(evaluationCase.brief.language.complexity, "absolute beginner");
const prose = [
	"Lina estas en la stacidomo.",
	"La loko estas tre trankvila.",
	"Lina vidas malgrandan ŝlosilon.",
	"Marko estas apud la benko.",
	"Lina montras la ŝlosilon al Marko.",
	"Marko konas la ŝlosilon.",
	"Ana laboras en la kafejo.",
	"Lina iras al Ana.",
	"Ana ricevas la ŝlosilon.",
	"Ana dankas Linan pro la helpo.",
	"La trajno nun estas ĉe la stacidomo.",
	"Lina eniras la trajnon kaj vojaĝas plu.",
].join(" ");
const deterministic = scoreManuscriptDeterministically(
	{ manuscript: { title: "La Eta Ŝlosilo", text: prose } },
	evaluationCase,
);
assert.equal(deterministic.checks.validManuscript, 1);
assert.equal(deterministic.checks.titleLength, 1);
assert.equal(deterministic.checks.nameCoverage, 1);
assert.ok(deterministic.score > 4);
assert.equal(
	scoreManuscriptDeterministically(
		{ validationError: "invalid JSON" },
		evaluationCase,
	).score,
	0,
);

assert.deepEqual(
	parseJudgeScore(
		JSON.stringify({
			grammarAndNaturalness: 5,
			beginnerSuitability: 4,
			languageFocusAdherence: 4,
			plotFidelity: 5,
			engagement: 3,
			preferenceAdherence: 5,
			needsEditing: false,
			seriousErrors: [],
			notes: "Clear and accurate.",
		}),
	),
	{
		grammarAndNaturalness: 5,
		beginnerSuitability: 4,
		languageFocusAdherence: 4,
		plotFidelity: 5,
		engagement: 3,
		preferenceAdherence: 5,
		needsEditing: false,
		seriousErrors: [],
		notes: "Clear and accurate.",
	},
);
assert.throws(
	() =>
		parseJudgeScore(
			JSON.stringify({
				grammarAndNaturalness: 5,
				beginnerSuitability: 4,
				languageFocusAdherence: 4,
				plotFidelity: 5,
				engagement: 3,
				preferenceAdherence: 5,
			}),
		),
	/needsEditing/,
);

console.log("model evaluation checks passed");
