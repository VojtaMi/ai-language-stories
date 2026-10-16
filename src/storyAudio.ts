import type { NarrationVoiceId } from "./narrationVoice";

export type OpeningAudioSource = "generated";

/**
 * One separately synthesized stretch of a recording: the text range it speaks
 * (`text.slice(textStart, textEnd)`) and when it plays, in seconds.
 */
export interface NarrationSegment {
	textStart: number;
	textEnd: number;
	start: number;
	end: number;
}

export interface StoryOpeningAudio {
	openingAudioUrl: string;
	openingAudioSource: OpeningAudioSource;
	openingAudioText?: string;
	openingAudioTextHash?: string;
	openingAudioVoice?: NarrationVoiceId;
	openingAudioProvider?: string;
	openingAudioModel?: string;
	openingAudioMimeType?: string;
	/** Measured request boundaries of a recording stitched from several requests. */
	openingAudioSegments?: NarrationSegment[];
}

export function isStoryOpeningAudioForText(
	audio: StoryOpeningAudio | null | undefined,
	text: string,
	voice?: NarrationVoiceId,
) {
	return (
		audio?.openingAudioText === text &&
		(!voice || !audio.openingAudioVoice || audio.openingAudioVoice === voice)
	);
}
