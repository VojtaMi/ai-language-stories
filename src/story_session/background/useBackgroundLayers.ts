import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { StoryBackgroundImage } from "../../storyBackground";

const BACKGROUND_FADE_DURATION_MS = 800;

export function backgroundLayerStyle(url: string): CSSProperties {
	return { "--background-url": `url("${url}")` } as CSSProperties;
}

export function useBackgroundLayers(
	view: "menu" | "story" | "lesson",
	backgroundImage: StoryBackgroundImage | null,
) {
	const [visibleBackgroundUrl, setVisibleBackgroundUrl] = useState<
		string | null
	>(null);
	const [previousBackgroundUrl, setPreviousBackgroundUrl] = useState<
		string | null
	>(null);
	const [isBackgroundFading, setIsBackgroundFading] = useState(false);
	const visibleUrlRef = useRef<string | null>(null);
	const nextUrl =
		view === "story" ? (backgroundImage?.backgroundImageUrl ?? null) : null;

	useEffect(() => {
		let cancelled = false;
		let timeout: number | undefined;
		setPreviousBackgroundUrl(null);
		setIsBackgroundFading(false);

		if (!nextUrl || !visibleUrlRef.current) {
			visibleUrlRef.current = nextUrl;
			setVisibleBackgroundUrl(nextUrl);
			return;
		}
		if (visibleUrlRef.current === nextUrl) return;

		const image = new Image();
		image.onload = () => {
			if (cancelled) return;
			setPreviousBackgroundUrl(visibleUrlRef.current);
			visibleUrlRef.current = nextUrl;
			setVisibleBackgroundUrl(nextUrl);
			setIsBackgroundFading(true);
			timeout = window.setTimeout(() => {
				setPreviousBackgroundUrl(null);
				setIsBackgroundFading(false);
			}, BACKGROUND_FADE_DURATION_MS);
		};
		image.src = nextUrl;

		return () => {
			cancelled = true;
			image.onload = null;
			if (timeout !== undefined) window.clearTimeout(timeout);
		};
	}, [nextUrl]);

	return { visibleBackgroundUrl, previousBackgroundUrl, isBackgroundFading };
}
