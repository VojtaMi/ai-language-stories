import { useCallback, useEffect, useRef, useState } from "react";

type OpeningAudioStatus = "idle" | "loading" | "playing" | "blocked" | "error";

const BUTTON_LABEL: Record<OpeningAudioStatus, string> = {
	idle: "Play opening narration",
	loading: "Loading opening narration",
	playing: "Pause opening narration",
	blocked: "Play opening narration",
	error: "Narration failed - click to retry",
};

const BUTTON_GLYPH: Record<OpeningAudioStatus, string> = {
	idle: "▶",
	loading: "...",
	playing: "⏸",
	blocked: "▶",
	error: "!",
};

interface OpeningAudioControlProps {
	audioUrl: string | null;
	isLoading?: boolean;
	hasError?: boolean;
	onRetry?: () => void;
	onPositionChange?: (time: number, duration: number) => void;
}

export function OpeningAudioControl({
	audioUrl,
	isLoading = false,
	hasError = false,
	onRetry,
	onPositionChange,
}: OpeningAudioControlProps) {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [status, setStatus] = useState<OpeningAudioStatus>("idle");
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const resumeAfterSeekRef = useRef(false);

	useEffect(() => {
		onPositionChange?.(currentTime, duration);
	}, [currentTime, duration, onPositionChange]);

	useEffect(() => {
		setCurrentTime(0);
		setDuration(0);

		if (!audioUrl) {
			setStatus("idle");
			return;
		}

		const audio = new Audio(audioUrl);
		audioRef.current = audio;
		let cancelled = false;

		const handleEnd = () => {
			if (cancelled) return;
			setStatus("idle");
			setCurrentTime(audio.duration);
		};
		const handleTimeUpdate = () => {
			if (!cancelled) setCurrentTime(audio.currentTime);
		};
		const handleLoadedMetadata = () => {
			if (!cancelled) setDuration(audio.duration || 0);
		};
		audio.addEventListener("ended", handleEnd);
		audio.addEventListener("timeupdate", handleTimeUpdate);
		audio.addEventListener("loadedmetadata", handleLoadedMetadata);

		async function playOpeningAudio() {
			setStatus("loading");
			try {
				await audio.play();
				if (!cancelled) setStatus("playing");
			} catch (err) {
				console.warn("Opening audio autoplay was blocked.", err);
				if (!cancelled) setStatus("blocked");
			}
		}

		void playOpeningAudio();

		return () => {
			cancelled = true;
			audio.removeEventListener("ended", handleEnd);
			audio.removeEventListener("timeupdate", handleTimeUpdate);
			audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
			audio.pause();
			audioRef.current = null;
		};
	}, [audioUrl]);

	const toggle = useCallback(async () => {
		const audio = audioRef.current;
		if (!audio) return;

		if (status === "playing") {
			audio.pause();
			setStatus("idle");
			return;
		}

		setStatus("loading");
		try {
			await audio.play();
			setStatus("playing");
		} catch (err) {
			console.warn("Could not play opening audio.", err);
			setStatus("error");
		}
	}, [status]);

	const previewSeek = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const nextTime = Number(event.target.value);
			setCurrentTime(nextTime);
			const audio = audioRef.current;
			if (audio) audio.currentTime = nextTime;
		},
		[],
	);

	const startSeek = useCallback(() => {
		const audio = audioRef.current;
		if (!audio || audio.paused) return;
		resumeAfterSeekRef.current = true;
		audio.pause();
		setStatus("idle");
	}, []);

	const commitSeek = useCallback(
		async (event: React.SyntheticEvent<HTMLInputElement>) => {
			const audio = audioRef.current;
			if (!audio) return;
			audio.currentTime = Number(event.currentTarget.value);

			if (!resumeAfterSeekRef.current) return;
			resumeAfterSeekRef.current = false;
			setStatus("loading");
			try {
				await audio.play();
				setStatus("playing");
			} catch (err) {
				console.warn("Could not resume opening audio after seeking.", err);
				setStatus("error");
			}
		},
		[],
	);

	const displayStatus: OpeningAudioStatus = !audioUrl
		? isLoading
			? "loading"
			: hasError
				? "error"
				: "idle"
		: status;

	if (!audioUrl && displayStatus === "idle") return null;

	const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

	return (
		<div className="story__opening-audio-group">
			<button
				type="button"
				className="story__opening-audio"
				data-status={displayStatus}
				aria-label={BUTTON_LABEL[displayStatus]}
				title={BUTTON_LABEL[displayStatus]}
				disabled={displayStatus === "loading"}
				onClick={() => {
					if (displayStatus === "error") onRetry?.();
					else void toggle();
				}}
			>
				{BUTTON_GLYPH[displayStatus]}
			</button>
			<input
				type="range"
				className="story__opening-audio-bar"
				min={0}
				max={duration || 0}
				step={0.1}
				value={currentTime}
				disabled={!audioUrl || !duration}
				aria-label="Seek narration"
				onChange={previewSeek}
				onPointerDown={startSeek}
				onPointerUp={commitSeek}
				onKeyUp={commitSeek}
				style={{ "--progress": `${progress}%` } as React.CSSProperties}
			/>
		</div>
	);
}
