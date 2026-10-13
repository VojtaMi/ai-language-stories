import {
	CHAT_MODELS,
	type ChatModelId,
	DEFAULT_CHAT_MODEL,
	DEFAULT_STORY_GENERATION_PRESET_ID,
	findStoryGenerationPreset,
	type StoryGenerationPresetId,
} from "../models";
import { DEFAULT_TTS_MODEL, isTtsModelId, type TtsModelId } from "../ttsModel";

const STORY_GENERATION_PRESET_STORAGE_KEY = "story-generation-preset";
const LEGACY_STORY_MODEL_STORAGE_KEY = "ai-model";
const CHAT_MODEL_STORAGE_KEY = "chat-model";
const NARRATION_MODEL_STORAGE_KEY = "narration-model";

export function readSelectedStoryGenerationPreset(): StoryGenerationPresetId {
	const stored = findStoryGenerationPreset(
		localStorage.getItem(STORY_GENERATION_PRESET_STORAGE_KEY),
	);
	if (stored) return stored.id;

	// Preserve the intent of the old model-only setting once. Reading stories
	// previously always used low reasoning, so Luna and Terra map to their low
	// presets; older or untested story models move to the recommended preset.
	const legacyModel = localStorage.getItem(LEGACY_STORY_MODEL_STORAGE_KEY);
	if (legacyModel === "gpt-5.6-luna") return "luna-low";
	if (legacyModel === "gpt-5.6-terra") return "terra-low";
	return DEFAULT_STORY_GENERATION_PRESET_ID;
}

export function saveSelectedStoryGenerationPreset(id: StoryGenerationPresetId) {
	localStorage.setItem(STORY_GENERATION_PRESET_STORAGE_KEY, id);
}

export function readSelectedChatModel(): ChatModelId {
	const stored = localStorage.getItem(CHAT_MODEL_STORAGE_KEY);
	return (
		CHAT_MODELS.find((model) => model.id === stored)?.id ?? DEFAULT_CHAT_MODEL
	);
}

export function saveSelectedChatModel(id: ChatModelId) {
	localStorage.setItem(CHAT_MODEL_STORAGE_KEY, id);
}

export function readSelectedNarrationModel(): TtsModelId {
	const stored = localStorage.getItem(NARRATION_MODEL_STORAGE_KEY);
	return isTtsModelId(stored) ? stored : DEFAULT_TTS_MODEL;
}

export function saveSelectedNarrationModel(id: TtsModelId) {
	localStorage.setItem(NARRATION_MODEL_STORAGE_KEY, id);
}
