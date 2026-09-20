import { toFile } from "openai";
import { traceAiCall } from "../aiTrace";
import type { GeneratedStoryImage, ProviderImageRequest } from "./types";

export const OPENAI_IMAGE_MODEL = "gpt-image-2.5-flare";

export async function generateOpenAiImage({
	openai,
	prompt,
	referenceImage,
}: ProviderImageRequest): Promise<GeneratedStoryImage> {
	const shared = {
		model: OPENAI_IMAGE_MODEL,
		prompt,
		size: "1536x1024",
		quality: "low",
		output_format: "webp",
		n: 1,
	} as const;

	const encoded = await traceAiCall(
		{
			kind: "image.generate",
			provider: "openai",
			model: OPENAI_IMAGE_MODEL,
			input: prompt,
			metadata: {
				n: 1,
				outputFormat: "webp",
				quality: "low",
				referenced: Boolean(referenceImage),
				size: "1536x1024",
			},
		},
		async () => {
			// An attached reference makes this an edit: the same prompt, anchored to
			// an earlier section so the characters stay recognizably themselves.
			const response = referenceImage
				? await openai.images.edit({
						...shared,
						image: [
							await toFile(referenceImage, "reference.webp", {
								type: "image/webp",
							}),
						],
					})
				: await openai.images.generate(shared);
			const encoded = response.data?.[0]?.b64_json;
			if (!encoded) throw new Error("The image API returned no image data.");
			return encoded;
		},
		(value) => ({
			imageChars: value.length,
		}),
	);

	return {
		extension: "webp",
		image: Buffer.from(encoded, "base64"),
		mimeType: "image/webp",
		model: OPENAI_IMAGE_MODEL,
		prompt,
		provider: "openai",
	};
}
