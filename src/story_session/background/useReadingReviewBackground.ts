import { useEffect, useState } from "react";
import { listStoryImages } from "../../gallery/galleryApi";
import type { Language } from "../../languages";
import type { StoryBackgroundImage } from "../../storyBackground";
import {
	buildSectionImageMap,
	fallbackBackgroundImage,
} from "./backgroundImages";

/** Reviewing only reads saved images; it never generates or persists media. */
export function useReadingReviewBackground(
	storyId: string | null,
	partIndex: number | null,
	currentBackground: StoryBackgroundImage | null,
	language: Language,
) {
	const [history, setHistory] = useState<{
		storyId: string;
		images: Record<number, StoryBackgroundImage>;
	} | null>(null);
	const currentUrl = currentBackground?.backgroundImageUrl;

	useEffect(() => {
		if (!storyId) return;
		let cancelled = false;
		void listStoryImages(storyId)
			.then((urls) => {
				if (!cancelled) {
					setHistory({
						storyId,
						images: buildSectionImageMap(
							currentUrl ? [...urls, currentUrl] : urls,
						),
					});
				}
			})
			.catch((error) => {
				console.warn("Could not load backgrounds for story review.", error);
			});
		return () => {
			cancelled = true;
		};
	}, [storyId, currentUrl]);

	if (partIndex === null || history?.storyId !== storyId) {
		return currentBackground;
	}
	for (let index = partIndex; index >= 1; index--) {
		if (history.images[index]) return history.images[index];
	}
	return fallbackBackgroundImage(language);
}
