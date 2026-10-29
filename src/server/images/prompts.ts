import type { Language } from "../../languages";

/**
 * Anchors a later section to the story's first image. The second sentence is
 * load-bearing: the reference predates every object the story introduces after
 * section 1, and without it the reference outvotes the scene description and
 * those objects go missing. The third covers the reverse: a prop in the
 * reference that the story has since moved or removed would otherwise be
 * copied in alongside the scene's own, showing one object twice.
 */
const REFERENCE_IMAGE_INSTRUCTION =
	"The attached image is an earlier scene of this same story, provided only to fix identity: keep the same faces, hair, clothing, creature design, and art style. " +
	"The scene description above has final authority over what happens and what is present: render every object it names, exactly as described, even when that object is absent from or looks different in the attached image. " +
	"Do not carry over any prop or object, or its position, from the attached image; show only the objects named above.";

export function buildStoryBackgroundPrompt(
	genre: Language,
	storyText: string,
	visualContext?: string,
	hasReferenceImage = false,
) {
	return [
		"Create a cinematic full-page background image",
		`Language: ${genre.label}.`,
		visualContext
			? `Visual continuity to preserve across images: ${visualContext}`
			: "",
		`Scene to depict: ${storyText}`,
		"Use a 16:9 landscape composition",
		"Put details toward the edges rather than behind the center.",
		"Most scenes should have no visible text at all. If a sign, poster, or billboard with writing would be natural, include at most one small, secondary instance, not a dominant subject.",
		hasReferenceImage ? REFERENCE_IMAGE_INSTRUCTION : "",
	]
		.filter(Boolean)
		.join("\n");
}
