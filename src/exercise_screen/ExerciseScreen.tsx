import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	getWordAudioUrl,
	logLearnerWordClick,
	regenerateWordAudioUrl,
} from "../ai";
import "../gallery/gallery.css";
import { GalleryModal } from "../gallery/GalleryModal";
import type { Language } from "../languages";
import { readSelectedNarrationModel } from "../modelSelection/modelSelectionStore";
import type { StoryFeedbackRecord } from "../storyFeedback";
import type { StoryRecapExerciseResult, StoryRecapLesson } from "../storyRecap";
import { isStoryName } from "../storyVocabulary";
import { LanguageChatModal } from "./chatbot/LanguageChatModal";
import { ExerciseControls } from "./controls/ExerciseControls";
import { estimateWordTimings, wordAtTime } from "./story/narrationTiming";
import { OpeningAudioControl } from "./story/OpeningAudioControl";
import { StoryCompletionView } from "./story/StoryCompletionView";
import { StoryLoading } from "./story/StoryLoading";
import { StoryLog } from "./story/StoryLog";
import { StoryRecapView } from "./story/StoryRecapView";
import "./story/storyPractice.css";
import type { StoryPhase, StorySegment } from "./types";

const WORD_PATTERN = /(\p{L}+(?:[-’']\p{L}+)*|[^\p{L}]+)/gu;

/** The sentence of `passage` in which `token` appears, for tutor context. */
function sentenceContaining(passage: string, token: string): string {
	const sentences = passage.match(/[^.!?]+[.!?]*["'”»]*/gu) ?? [passage];
	return (
		sentences.find((sentence) => sentence.includes(token))?.trim() ??
		passage.trim()
	);
}

interface WordPopover {
	word: string;
	/** The word exactly as written, and the passage it was tapped in. */
	token: string;
	passage: string;
	translation: string;
	isName: boolean;
	x: number;
	y: number;
}

interface ExerciseScreenProps {
	language: Language;
	segments: StorySegment[];
	currentTarget: string | null;
	phase: StoryPhase;
	error: string | null;
	backgroundIntro?: string;
	storyId: string | null;
	currentImageUrl: string | null;
	openingAudioUrl: string | null;
	openingAudioLoading?: boolean;
	openingAudioError?: boolean;
	onRetryOpeningAudio?: () => void;
	readingPartIndex: number | null;
	readingTotalParts: number | null;
	storyFeedbackSubmittedAt: string | null;
	storyFeedback: string | null;
	feedbackEditable: boolean;
	wordTranslations: Record<string, string> | null;
	nonTranslatableWords: string[];
	storyRecapLesson: StoryRecapLesson | null;
	storyRecapError: string | null;
	onRegenerateWord: (word: string) => Promise<string | null>;
	onContinueReading: () => void;
	onSelectReadingPart?: (partIndex: number | null) => void;
	onCompleteStoryRecap: (results: StoryRecapExerciseResult[]) => void;
	onRetryStoryRecap: () => void;
	onSkipStoryRecap: () => void;
	onBackToMenu: () => void;
	onSubmitStoryFeedback: (record: StoryFeedbackRecord) => void;
	onStoryFeedbackDraftChange: (record: StoryFeedbackRecord) => void;
	/** Buffers the learner's tutor questions for the reading-story baseline. */
	onCaptureBotQuestions: (questions: string[]) => void;
}

export default function ExerciseScreen({
	language,
	segments,
	currentTarget,
	phase,
	error,
	backgroundIntro,
	storyId,
	currentImageUrl,
	openingAudioUrl,
	openingAudioLoading,
	openingAudioError,
	onRetryOpeningAudio,
	readingPartIndex,
	readingTotalParts,
	storyFeedbackSubmittedAt,
	storyFeedback,
	feedbackEditable,
	wordTranslations,
	nonTranslatableWords,
	storyRecapLesson,
	storyRecapError,
	onRegenerateWord,
	onContinueReading,
	onSelectReadingPart,
	onCompleteStoryRecap,
	onRetryStoryRecap,
	onSkipStoryRecap,
	onBackToMenu,
	onSubmitStoryFeedback,
	onStoryFeedbackDraftChange,
	onCaptureBotQuestions,
}: ExerciseScreenProps) {
	const [galleryOpen, setGalleryOpen] = useState(false);
	const [chatOpen, setChatOpen] = useState(false);
	const [tutorQuestion, setTutorQuestion] = useState<{
		id: number;
		text: string;
	} | null>(null);
	const [popover, setPopover] = useState<WordPopover | null>(null);
	const [regenerating, setRegenerating] = useState(false);
	const [wordAudioUrls, setWordAudioUrls] = useState<Record<string, string>>(
		{},
	);
	const [selectedPart, setSelectedPart] = useState<{
		storyId: string | null;
		target: string | null;
		index: number;
	} | null>(null);
	const canSelectParts = phase === "reading" || phase === "finished";
	const selectedIndex =
		canSelectParts &&
		selectedPart?.storyId === storyId &&
		selectedPart?.target === currentTarget
			? selectedPart.index
			: segments.length;
	const reviewing = selectedIndex < segments.length;
	const activeText = reviewing ? segments[selectedIndex].text : currentTarget;
	const activeAudioUrl = reviewing
		? (segments[selectedIndex].narrationAudio?.openingAudioUrl ?? null)
		: openingAudioUrl;
	const [narrationPosition, setNarrationPosition] = useState<{
		audioUrl: string | null;
		text: string | null;
		time: number;
		duration: number;
	} | null>(null);
	const updateNarrationPosition = useCallback(
		(time: number, duration: number) => {
			setNarrationPosition({
				audioUrl: activeAudioUrl,
				text: activeText,
				time,
				duration,
			});
		},
		[activeAudioUrl, activeText],
	);
	const wordTimings = useMemo(
		() => estimateWordTimings(activeText ?? ""),
		[activeText],
	);
	const activeWordOffset =
		activeAudioUrl &&
		narrationPosition?.audioUrl === activeAudioUrl &&
		narrationPosition.text === activeText
			? narrationPosition.duration > 0 &&
				narrationPosition.time >= narrationPosition.duration
				? (activeText?.length ?? null)
				: narrationPosition.time > 0
					? wordAtTime(
							wordTimings,
							narrationPosition.time,
							narrationPosition.duration,
						)
					: null
			: null;
	const selectPart = (index: number) => {
		setPopover(null);
		setSelectedPart({ storyId, target: currentTarget, index });
		onSelectReadingPart?.(index < segments.length ? index + 1 : null);
	};
	const laterSegments = reviewing
		? [
				...segments.slice(selectedIndex + 1),
				...(phase === "reading" && currentTarget
					? [
							{
								id: -1,
								author: "ai" as const,
								text: currentTarget,
							},
						]
					: []),
			]
		: [];
	const popoverRef = useRef<HTMLDivElement>(null);

	const canShowGallery =
		Boolean(storyId) &&
		Boolean(currentImageUrl?.startsWith("/api/story-images/"));
	const readingProgress =
		(reviewing || readingPartIndex !== null) && readingTotalParts !== null
			? `Part ${reviewing ? selectedIndex + 1 : readingPartIndex} of ${readingTotalParts}`
			: null;
	const canContinueReading =
		phase === "reading" &&
		currentTarget !== null &&
		readingPartIndex !== null &&
		readingTotalParts !== null;

	useEffect(() => {
		if (!popover) return;
		const handler = (e: MouseEvent) => {
			if (!popoverRef.current?.contains(e.target as Node)) {
				setPopover(null);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setPopover(null);
		};
		// The popover is pinned to viewport coordinates, so it would drift away
		// from its word as soon as the page moves under it.
		const close = () => setPopover(null);
		document.addEventListener("mousedown", handler);
		document.addEventListener("keydown", onKey);
		window.addEventListener("scroll", close, { passive: true });
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("mousedown", handler);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", close);
			window.removeEventListener("resize", close);
		};
	}, [popover]);

	const playWordAudio = (word: string, audioUrl?: string) => {
		const normalizedWord = word.toLowerCase();
		const existingUrl = audioUrl ?? wordAudioUrls[normalizedWord];
		(existingUrl
			? Promise.resolve(existingUrl)
			: getWordAudioUrl(
					language.id,
					normalizedWord,
					readSelectedNarrationModel(),
				)
		)
			.then((url) => {
				if (!existingUrl) {
					setWordAudioUrls((prev) => ({ ...prev, [normalizedWord]: url }));
				}
				return new Audio(url).play();
			})
			.catch(() => {
				const utt = new SpeechSynthesisUtterance(word);
				utt.lang = language.locale;
				speechSynthesis.cancel();
				speechSynthesis.speak(utt);
			});
	};

	const handleWordClick = (
		token: string,
		translation: string,
		isName: boolean,
		e: React.MouseEvent<HTMLButtonElement>,
	) => {
		// Word popovers only appear while reading, so every lookup here belongs to
		// this story — scope it so the story's baseline (not the global cursor)
		// folds it and no other story can consume it.
		void logLearnerWordClick(language.id, token, storyId ?? undefined);
		playWordAudio(token);

		const rect = e.currentTarget.getBoundingClientRect();
		setPopover({
			word: token.toLowerCase(),
			token,
			passage: activeText ?? "",
			translation,
			isName,
			x: rect.left + rect.width / 2,
			y: rect.top,
		});
	};

	const askTutorAboutWord = () => {
		if (!popover) return;
		setTutorQuestion((previous) => ({
			id: (previous?.id ?? 0) + 1,
			text: `What does "${popover.token}" mean in "${sentenceContaining(popover.passage, popover.token)}", and why does it have this form?`,
		}));
		setPopover(null);
		setChatOpen(true);
	};

	const handleRegenerate = async () => {
		if (!popover || regenerating) return;
		setRegenerating(true);
		try {
			const [updated, audioUrl] = await Promise.all([
				onRegenerateWord(popover.word),
				regenerateWordAudioUrl(language.id, popover.word),
			]);
			if (updated) setPopover((p) => p && { ...p, translation: updated });
			setWordAudioUrls((prev) => ({ ...prev, [popover.word]: audioUrl }));
			playWordAudio(popover.word, audioUrl);
		} finally {
			setRegenerating(false);
		}
	};

	return (
		<div className="story">
			{backgroundIntro && <p className="story__intro">{backgroundIntro}</p>}

			<StoryLog
				segments={canSelectParts ? segments.slice(0, selectedIndex) : segments}
				onSelectSegment={canSelectParts ? selectPart : undefined}
				lang={language.locale}
			/>

			{canSelectParts && activeText && (phase === "reading" || reviewing) && (
				<div className="story__reading" key={selectedIndex}>
					<div className="story__reading-header">
						{readingProgress && (
							<p className="story__reading-progress">{readingProgress}</p>
						)}
					</div>
					<p className="story__reading-text" lang={language.locale}>
						{[...(activeText ?? "").matchAll(WORD_PATTERN)].map((match) => {
							const token = match[1];
							const isWord = /\p{L}/u.test(token);
							const narrationClass = !activeAudioUrl
								? undefined
								: activeWordOffset !== null && match.index <= activeWordOffset
									? "story__narration-token story__narration-token--read"
									: "story__narration-token";
							if (!isWord)
								return (
									<span key={match.index} className={narrationClass}>
										{token}
									</span>
								);
							const isName = isStoryName(
								token,
								nonTranslatableWords,
								language.id,
							);
							const translation = isName
								? "(name)"
								: wordTranslations?.[token.toLowerCase()];
							return translation ? (
								<button
									key={match.index}
									type="button"
									className={`story__word ${narrationClass ?? ""}`}
									onClick={(e) =>
										handleWordClick(token, translation, isName, e)
									}
								>
									{token}
								</button>
							) : (
								<span key={match.index} className={narrationClass}>
									{token}
								</span>
							);
						})}
					</p>
					<OpeningAudioControl
						audioUrl={activeAudioUrl}
						onPositionChange={updateNarrationPosition}
						isLoading={!reviewing && openingAudioLoading}
						hasError={!reviewing && openingAudioError}
						onRetry={reviewing ? undefined : onRetryOpeningAudio}
					/>
					{phase === "reading" && (
						<div className="story__reading-actions">
							<button
								type="button"
								className="story__reading-next"
								disabled={!canContinueReading}
								onClick={() =>
									reviewing
										? selectPart(selectedIndex + 1)
										: onContinueReading()
								}
							>
								{canContinueReading &&
								!reviewing &&
								readingPartIndex === readingTotalParts
									? "Finish story"
									: "Next part"}
							</button>
						</div>
					)}
				</div>
			)}

			{reviewing && (
				<StoryLog
					segments={laterSegments}
					onSelectSegment={(index) => selectPart(selectedIndex + 1 + index)}
					lang={language.locale}
				/>
			)}

			{(phase === "recap-loading" || phase === "recap") && (
				<StoryRecapView
					lesson={storyRecapLesson}
					error={storyRecapError}
					onComplete={onCompleteStoryRecap}
					onRetry={onRetryStoryRecap}
					onSkip={onSkipStoryRecap}
				/>
			)}

			{phase === "finished" && (
				<StoryCompletionView
					storyId={storyId}
					currentImageUrl={currentImageUrl}
					readingTotalParts={readingTotalParts}
					storyFeedbackSubmittedAt={storyFeedbackSubmittedAt}
					feedbackEditable={feedbackEditable}
					priorFeedback={storyFeedback}
					canShowGallery={canShowGallery}
					onOpenGallery={() => setGalleryOpen(true)}
					onSubmitStoryFeedback={onSubmitStoryFeedback}
					onStoryFeedbackDraftChange={onStoryFeedbackDraftChange}
				/>
			)}

			{phase === "loading" && <StoryLoading />}

			{popover && (
				<div
					ref={popoverRef}
					role="status"
					className="story__word-popover"
					style={{ left: popover.x, top: popover.y }}
				>
					<span>{popover.translation}</span>
					{!popover.isName && (
						<button
							type="button"
							className="story__word-popover__ask"
							title={`Ask ${language.label} Bot about this word`}
							aria-label={`Ask ${language.label} Bot about ${popover.token}`}
							onClick={askTutorAboutWord}
						>
							Ask
						</button>
					)}
					{!popover.isName && (
						<button
							type="button"
							className="story__word-popover__regenerate"
							title="Regenerate translation"
							disabled={regenerating}
							onClick={handleRegenerate}
						>
							↺
						</button>
					)}
				</div>
			)}

			{error && <p className="story__error">{error}</p>}

			<ExerciseControls
				storyId={storyId}
				currentImageUrl={currentImageUrl}
				onBackToMenu={onBackToMenu}
				onOpenGallery={() => setGalleryOpen(true)}
			/>

			<LanguageChatModal
				language={language}
				isOpen={chatOpen}
				onOpen={() => setChatOpen(true)}
				segments={segments}
				currentTarget={currentTarget}
				backgroundIntro={backgroundIntro}
				onClose={() => setChatOpen(false)}
				onCaptureQuestions={onCaptureBotQuestions}
				pendingQuestion={tutorQuestion}
			/>

			{galleryOpen && canShowGallery && storyId && currentImageUrl && (
				<GalleryModal
					storyId={storyId}
					currentImageUrl={currentImageUrl}
					onClose={() => setGalleryOpen(false)}
				/>
			)}
		</div>
	);
}
