import type { TextModelId } from "./models";
import type { TtsModelId } from "./ttsModel";

export interface ProviderAvailability {
	openai: boolean;
	gemini: boolean;
	anthropic: boolean;
}

export function textModelProvider(model: TextModelId) {
	if (model.startsWith("gemini-")) return "gemini" as const;
	if (model.startsWith("claude-")) return "anthropic" as const;
	return "openai" as const;
}

export function isTextModelAvailable(
	model: TextModelId,
	availability: ProviderAvailability,
) {
	return availability[textModelProvider(model)];
}

export function isTtsModelAvailable(
	model: TtsModelId,
	availability: ProviderAvailability,
) {
	return model === "openai" ? availability.openai : availability.gemini;
}
