import { useCallback, useEffect, useRef, useState } from "react";
import {
	getWordAudioUrl,
	logLearnerWordClick,
	regenerateWordAudioUrl,
} from "../ai";
import type { NarrationSegment } from "../storyAudio";
import "../gallery/gallery.css";
import { GalleryModal } from "../gallery/GalleryModal";
import type { Language } from "../languages";
import { readSelectedNarrationModel } from "../modelSelection/modelSelectionStore";
import type { StoryFeedbackRecord } from "../storyFeedback";
import type { StoryRecapExerciseResult, StoryRecapLesson } from "../storyRecap";
import { isStoryName } from "../storyVocabulary";
import { LanguageChatModal } from "./chatbot/LanguageChatModal";
import { ExerciseControls } from "./controls/ExerciseControls";
import { narrationWordAtTime } from "./story/narrationTiming";
import { OpeningAudioControl } from "./story/OpeningAudioControl";
import { StoryCompletionView } from "./story/StoryCompletionView";
import { StoryLoading } from "./story/StoryLoading";
import { StoryLog } from "./story/StoryLog";
import { StoryRecapView } from "./story/StoryRecapView";
import "./story/storyPractice.css";
import type { StoryPhase, StorySegment } from "./types";

/** Hover shows a word's translation after this pause, so sweeping the pointer across text stays quiet. */
const HOVER_HINT_DELAY_MS = 300;
/** A hover this long means the learner read the translation, so it counts as a lookup. */
const HOVER_LOOKUP_DELAY_MS = 1000;

/** Only a real mouse pointer hovers; touch keeps tap-for-everything. */
function canHover(): boolean {
	return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

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

/** The translation-only tooltip shown on hover or keyboard focus. */
interface WordHint {
	translation: string;
	x: number;
	y: number;
}

function wordAnchor(element: HTMLElement): { x: number; y: number } {
	const rect = element.getBoundingClientRect();
	return { x: rect.left + rect.width / 2, y: rect.top };
}

interface ExerciseScreenProps {
	language: Language;
	segments: StorySegment[];
	currentTarget: string | null;
	phase: StoryPhase;
	error: string | null;
	backgroundIntro?: string;
	languageFocus?: string;
	storyId: string | null;
	currentImageUrl: string | null;
	openingAudioUrl: string | null;
	openingAudioSegments?: NarrationSegment[];
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
	/** Records a story word the learner tapped for help. */
	onWordLookup: (word: string) => void;
}

export default function ExerciseScreen({
	language,
	segments,
	currentTarget,
	phase,
	error,
	backgroundIntro,
	languageFocus,
	storyId,
	currentImageUrl,
	openingAudioUrl,
	openingAudioSegments,
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
	onWordLookup,
}: ExerciseScreenProps) {
	// Where an open gallery starts: the finished story reviews from the first
	// picture, while reading it opens on the picture behind the text.
	const [galleryStart, setGalleryStart] = useState<"first" | "current" | null>(
		null,
	);
	const [chatOpen, setChatOpen] = useState(false);
	const [tutorQuestion, setTutorQuestion] = useState<{
		id: number;
		text: string;
	} | null>(null);
	const [popover, setPopover] = useState<WordPopover | null>(null);
	const [wordHint, setWordHint] = useState<WordHint | null>(null);
	const hoverTimersRef = useRef<number[]>([]);
	// Whether the current hover already logged its word, so a click on it after
	// a long hover is not counted as a second lookup.
	const hoverLoggedRef = useRef(false);
	const [regenerating, setRegenerating] = useState(false);
	const [wordAudioUrls, setWordAudioUrls] = useState<Record<string, string>>(
		{},
	);
	// One channel for word pronunciation: each click supersedes the last, so a
	// slow response for an earlier word never plays over a later one.
	const wordAudioRef = useRef<HTMLAudioElement | null>(null);
	const wordAudioRequestRef = useRef(0);
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
	const activeAudioSegments = reviewing
		? segments[selectedIndex].narrationAudio?.openingAudioSegments
		: openingAudioSegments;
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
	const activeWordOffset =
		activeAudioUrl &&
		narrationPosition?.audioUrl === activeAudioUrl &&
		narrationPosition.text === activeText
			? narrationPosition.duration > 0 &&
				narrationPosition.time >= narrationPosition.duration
				? (activeText?.length ?? null)
				: narrationPosition.time > 0
					? narrationWordAtTime(
							activeText ?? "",
							narrationPosition.time,
							narrationPosition.duration,
							activeAudioSegments,
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
			// Another word's click replaces the popover itself; closing it first
			// would briefly resume the narration between the two words.
			if (
				!popoverRef.current?.contains(e.target as Node) &&
				!(e.target as Element).closest?.(".story__word")
			) {
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

	const stopWordAudio = useCallback(() => {
		wordAudioRequestRef.current++;
		wordAudioRef.current?.pause();
		speechSynthesis.cancel();
	}, []);

	// Closing the popover (or leaving the story) silences its word.
	useEffect(() => {
		if (!popover) stopWordAudio();
	}, [popover, stopWordAudio]);
	useEffect(() => stopWordAudio, [stopWordAudio]);

	const playWordAudio = (word: string, audioUrl?: string) => {
		stopWordAudio();
		const request = wordAudioRequestRef.current;
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
				if (request !== wordAudioRequestRef.current) return;
				wordAudioRef.current ??= new Audio();
				wordAudioRef.current.src = url;
				return wordAudioRef.current.play();
			})
			.catch(() => {
				if (request !== wordAudioRequestRef.current) return;
				const utt = new SpeechSynthesisUtterance(word);
				utt.lang = language.locale;
				speechSynthesis.cancel();
				speechSynthesis.speak(utt);
			});
	};

	const clearWordHover = useCallback(() => {
		for (const timer of hoverTimersRef.current) window.clearTimeout(timer);
		hoverTimersRef.current = [];
		setWordHint(null);
	}, []);
	useEffect(() => clearWordHover, [clearWordHover]);

	// The hint is pinned to viewport coordinates, like the popover.
	useEffect(() => {
		if (!wordHint) return;
		window.addEventListener("scroll", clearWordHover, { passive: true });
		return () => window.removeEventListener("scroll", clearWordHover);
	}, [wordHint, clearWordHover]);

	const logWordLookup = (token: string, isName: boolean) => {
		// Word lookups only happen while reading, so every lookup here belongs to
		// this story — scope it so the story's baseline (not the global cursor)
		// folds it and no other story can consume it.
		void logLearnerWordClick(language.id, token, storyId ?? undefined);
		if (!isName) onWordLookup(token);
	};

	const handleWordPointerEnter = (
		token: string,
		translation: string,
		isName: boolean,
		e: React.PointerEvent<HTMLButtonElement>,
	) => {
		if (e.pointerType !== "mouse" || !canHover() || popover) return;
		clearWordHover();
		hoverLoggedRef.current = false;
		const anchor = wordAnchor(e.currentTarget);
		hoverTimersRef.current = [
			window.setTimeout(
				() => setWordHint({ translation, ...anchor }),
				HOVER_HINT_DELAY_MS,
			),
			window.setTimeout(() => {
				hoverLoggedRef.current = true;
				logWordLookup(token, isName);
			}, HOVER_LOOKUP_DELAY_MS),
		];
	};

	const handleWordFocus = (
		translation: string,
		e: React.FocusEvent<HTMLButtonElement>,
	) => {
		if (popover || !e.currentTarget.matches(":focus-visible")) return;
		setWordHint({ translation, ...wordAnchor(e.currentTarget) });
	};

	const handleWordClick = (
		token: string,
		translation: string,
		isName: boolean,
		e: React.MouseEvent<HTMLButtonElement>,
	) => {
		clearWordHover();
		const loggedByHover = hoverLoggedRef.current;
		hoverLoggedRef.current = false;
		if (!loggedByHover) logWordLookup(token, isName);
		playWordAudio(token);

		setPopover({
			word: token.toLowerCase(),
			token,
			passage: activeText ?? "",
			translation,
			isName,
			...wordAnchor(e.currentTarget),
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
									onPointerEnter={(e) =>
										handleWordPointerEnter(token, translation, isName, e)
									}
									onPointerLeave={clearWordHover}
									onFocus={(e) => handleWordFocus(translation, e)}
									onBlur={clearWordHover}
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
						interrupted={popover !== null}
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
					onOpenGallery={() => setGalleryStart("first")}
					onSubmitStoryFeedback={onSubmitStoryFeedback}
					onStoryFeedbackDraftChange={onStoryFeedbackDraftChange}
				/>
			)}

			{phase === "loading" && <StoryLoading />}

			{wordHint && !popover && (
				<div
					role="tooltip"
					className="story__word-popover story__word-popover--hint"
					style={{ left: wordHint.x, top: wordHint.y }}
				>
					{wordHint.translation}
				</div>
			)}

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
				onOpenGallery={() => setGalleryStart("current")}
			/>

			<LanguageChatModal
				language={language}
				isOpen={chatOpen}
				onOpen={() => setChatOpen(true)}
				segments={segments}
				currentTarget={currentTarget}
				backgroundIntro={backgroundIntro}
				languageFocus={languageFocus}
				onClose={() => setChatOpen(false)}
				onCaptureQuestions={onCaptureBotQuestions}
				pendingQuestion={tutorQuestion}
			/>

			{galleryStart && canShowGallery && storyId && currentImageUrl && (
				<GalleryModal
					storyId={storyId}
					currentImageUrl={currentImageUrl}
					startAtCurrent={galleryStart === "current"}
					onClose={() => setGalleryStart(null)}
				/>
			)}
		</div>
	);
}
