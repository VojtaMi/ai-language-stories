import assert from "node:assert/strict";
import type OpenAI from "openai";
import { getWordAudioUrl } from "../src/ai.ts";
import {
	readSelectedChatModel,
	readSelectedNarrationModel,
	readSelectedStoryGenerationPreset,
	saveSelectedChatModel,
	saveSelectedStoryGenerationPreset,
} from "../src/modelSelection/modelSelectionStore.ts";
import {
	CHAT_MODELS,
	DEFAULT_CHAT_MODEL,
	DEFAULT_STORY_GENERATION_PRESET_ID,
	getStoryGenerationPreset,
	STORY_GENERATION_PRESETS,
} from "../src/models.ts";
import { prepareMissingReadingOpenings } from "../src/openings.ts";
import {
	isTextModelAvailable,
	isTtsModelAvailable,
} from "../src/providerAvailability.ts";
import { completeAi } from "../src/server/aiService.ts";
import { OPENAI_IMAGE_MODEL } from "../src/server/images/index.ts";
import { DEFAULT_GEMINI_TTS_MODEL } from "../src/server/tts/constants.ts";
import { synthesizeGeminiSpeech } from "../src/server/tts/geminiTts.ts";
import { DEFAULT_TTS_MODEL } from "../src/ttsModel.ts";

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
assert.equal(isTextModelAvailable("gpt-6-sol", openaiOnly), true);
assert.equal(isTextModelAvailable("gemini-2.5-flash", openaiOnly), false);
assert.equal(isTextModelAvailable("claude-sonnet-4-6", openaiOnly), false);
assert.equal(isTtsModelAvailable("openai", openaiOnly), true);
assert.equal(isTtsModelAvailable("gemini-3.8-flash-tts", openaiOnly), false);
console.log("checked model selection: provider availability");

assert.equal(OPENAI_IMAGE_MODEL, "gpt-image-2.5-flare");
console.log("checked model selection: OpenAI image model uses the Flare alias");

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
		"gemini-3.8-flash-tts",
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
	ttsModel: "gemini-3.8-flash-tts",
});
console.log("checked model selection: reading request forwards the preset");

globalThis.fetch = async (_input, init) => {
	requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
	return Response.json({ url: "/api/word-audio/latin/vinum?v=1" });
};
try {
	assert.equal(
		await getWordAudioUrl("latin", "vinum", "gemini-3.8-flash-tts"),
		"/api/word-audio/latin/vinum?v=1",
	);
	assert.deepEqual(requestBody, {
		genreId: "latin",
		word: "vinum",
		ttsModel: "gemini-3.8-flash-tts",
	});
} finally {
	globalThis.fetch = originalFetch;
}
console.log("checked word audio: client forwards the selected narration model");

console.log("\nmodel selection checks passed");

assert.equal(DEFAULT_TTS_MODEL, "gemini-3.8-flash-lite-tts");
assert.equal(DEFAULT_GEMINI_TTS_MODEL, DEFAULT_TTS_MODEL);
assert.equal(readSelectedNarrationModel(), DEFAULT_TTS_MODEL);
const originalKey = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = "test-key";
try {
	for (const model of [
		"gemini-3.8-flash-tts",
		"gemini-3.8-flash-lite-tts",
		"gemini-3.1-flash-tts-preview",
	] as const) {
		const modern = model.startsWith("gemini-3.8-");
		const bytes = modern
			? Buffer.from("RIFFtestWAVE")
			: Buffer.from([1, 0, 2, 0]);
		globalThis.fetch = async (url, init) => {
			assert.ok(String(url).includes(model));
			const body = JSON.parse(String(init?.body));
			const part = body.contents[0].parts[0];
			if (modern) {
				assert.equal(part.text, "Ĉu ŝi ĝojas?");
				assert.ok(part.speech_metadata.style.includes("Slowly."));
				assert.equal(
					body.generationConfig.speechConfig.voiceConfig.voice,
					"Kore",
				);
			} else {
				assert.ok(part.text.includes("Transcript:"));
				assert.equal(
					body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig
						.voiceName,
					"Kore",
				);
			}
			return Response.json({
				candidates: [
					{
						content: {
							parts: [
								{
									inlineData: {
										data: bytes.toString("base64"),
										mimeType: modern ? "audio/wav" : "audio/l16; rate=24000",
									},
								},
							],
						},
					},
				],
			});
		};
		const result = await synthesizeGeminiSpeech({
			openai: {} as OpenAI,
			input: "Ĉu ŝi ĝojas?",
			instructions: "Slowly.",
			voice: "Kore",
			geminiModel: model,
		});
		if (modern) assert.deepEqual(result.audio, bytes);
		else {
			assert.equal(result.audio.toString("ascii", 0, 4), "RIFF");
			assert.deepEqual(result.audio.subarray(44), bytes);
		}
	}
} finally {
	globalThis.fetch = originalFetch;
	if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
	else process.env.GEMINI_API_KEY = originalKey;
}
console.log(
	"checked narration: Flash-Lite default, speech metadata, and WAV handling",
);

// The tutor only restores supported chat choices, independently of story models.
assert.equal(readSelectedChatModel(), DEFAULT_CHAT_MODEL);
assert.equal(DEFAULT_CHAT_MODEL, "gpt-6-luna");
for (const model of CHAT_MODELS) {
	saveSelectedChatModel(model.id);
	assert.equal(readSelectedChatModel(), model.id);
}
stored.set("chat-model", "gpt-5.6-luna");
assert.equal(readSelectedChatModel(), "gpt-6-luna");
stored.set("chat-model", "unknown-model");
assert.equal(readSelectedChatModel(), "gpt-6-luna");
console.log("checked tutor selection: persistence and retired model reset");

const previousOpenAiKey = process.env.OPENAI_API_KEY;
const previousGeminiKey = process.env.GEMINI_API_KEY;
process.env.OPENAI_API_KEY = "test-key";
process.env.GEMINI_API_KEY = "test-key";
try {
	const openai = {
		chat: {
			completions: {
				create: async (body: Record<string, unknown>) => {
					assert.equal(body.model, "gpt-6-luna");
					assert.equal(body.reasoning_effort, "none");
					return {
						choices: [
							{ message: { content: "Hello." }, finish_reason: "stop" },
						],
					};
				},
			},
		},
	} as unknown as OpenAI;
	assert.equal(
		await completeAi(
			openai,
			[{ role: "user", content: "Hello" }],
			520,
			"gpt-6-luna",
		),
		"Hello.",
	);
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(String(init?.body));
		if (String(url).includes("anthropic.com")) {
			assert.equal(body.model, "claude-haiku-5-5");
			assert.deepEqual(body.thinking, { type: "disabled" });
			return Response.json({
				content: [
					{ type: "thinking", thinking: "", signature: "test" },
					{ type: "text", text: "Hello." },
				],
				stop_reason: "end_turn",
			});
		}
		assert.ok(String(url).includes("gemini-3.8-flash:generateContent"));
		assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "low");
		assert.ok(body.generationConfig.maxOutputTokens > 520);
		return Response.json({
			candidates: [
				{ content: { parts: [{ text: "Hello." }] }, finishReason: "STOP" },
			],
		});
	};
	for (const model of ["claude-haiku-5-5", "gemini-3.8-flash"] as const) {
		assert.equal(
			await completeAi(
				openai,
				[{ role: "user", content: "Hello" }],
				520,
				model,
				"test-key",
			),
			"Hello.",
		);
	}
} finally {
	globalThis.fetch = originalFetch;
	if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = previousOpenAiKey;
	if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
	else process.env.GEMINI_API_KEY = previousGeminiKey;
}
console.log("checked tutor providers: request settings and answer extraction");
