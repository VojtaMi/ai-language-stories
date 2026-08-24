import assert from "node:assert/strict";
import {
	readSelectedStoryGenerationPreset,
	saveSelectedStoryGenerationPreset,
} from "../src/modelSelection/modelSelectionStore.ts";
import {
	DEFAULT_STORY_GENERATION_PRESET_ID,
	getStoryGenerationPreset,
	STORY_GENERATION_PRESETS,
} from "../src/models.ts";
import { prepareMissingReadingOpenings } from "../src/openings.ts";
import {
	isTextModelAvailable,
	isTtsModelAvailable,
} from "../src/providerAvailability.ts";

const stored = new Map<string, string>();
const localStorageStub = {
	getItem: (key: string) => stored.get(key) ?? null,
	setItem: (key: string, value: string) => stored.set(key, value),
} as Storage;
Object.defineProperty(globalThis, "localStorage", { value: localStorageStub });

assert.deepEqual(
	STORY_GENERATION_PRESETS.map((preset) => preset.id),
	["terra-medium", "terra-low", "luna-low"],
);
assert.deepEqual(getStoryGenerationPreset("terra-medium"), {
	id: "terra-medium",
	label: "GPT 5.6 Terra · Medium",
	model: "gpt-5.6-terra",
	reasoningEffort: "medium",
});
assert.equal(
	readSelectedStoryGenerationPreset(),
	DEFAULT_STORY_GENERATION_PRESET_ID,
);

stored.set("ai-model", "gpt-5.6-luna");
assert.equal(readSelectedStoryGenerationPreset(), "luna-low");
stored.set("ai-model", "gpt-5.6-terra");
assert.equal(readSelectedStoryGenerationPreset(), "terra-low");
stored.set("ai-model", "gemini-2.5-flash");
assert.equal(
	readSelectedStoryGenerationPreset(),
	DEFAULT_STORY_GENERATION_PRESET_ID,
);

saveSelectedStoryGenerationPreset("luna-low");
assert.equal(readSelectedStoryGenerationPreset(), "luna-low");
console.log("checked model selection: curated presets and stored selection");

const openaiOnly = { openai: true, gemini: false, anthropic: false };
assert.equal(isTextModelAvailable("gpt-5.6-luna", openaiOnly), true);
assert.equal(isTextModelAvailable("gemini-2.5-flash", openaiOnly), false);
assert.equal(isTextModelAvailable("claude-sonnet-4-6", openaiOnly), false);
assert.equal(isTtsModelAvailable("openai", openaiOnly), true);
assert.equal(
	isTtsModelAvailable("gemini-3.1-flash-tts-preview", openaiOnly),
	false,
);
console.log("checked model selection: provider availability");

let requestBody: Record<string, unknown> | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
	requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
	return new Response("[]", {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};
try {
	await prepareMissingReadingOpenings(
		"esperanto",
		getStoryGenerationPreset("terra-medium"),
		"previous-story",
		"a floating city",
		"gemini-3.1-flash-tts-preview",
	);
} finally {
	globalThis.fetch = originalFetch;
}
assert.deepEqual(requestBody, {
	genreId: "esperanto",
	model: "gpt-5.6-terra",
	reasoningEffort: "medium",
	basedOnStoryId: "previous-story",
	nextTheme: "a floating city",
	ttsModel: "gemini-3.1-flash-tts-preview",
});
console.log("checked model selection: reading request forwards the preset");

console.log("\nmodel selection checks passed");
