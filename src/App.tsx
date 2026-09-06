import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import ExerciseScreen from "./exercise_screen/ExerciseScreen";
import MainMenu from "./home_menu/MainMenu";
import {
	readSelectedLanguage,
	selectLanguage,
	syncLanguageDocument,
} from "./languageSelection";
import { getLanguage, isLanguageId, type LanguageId } from "./languages";
import {
	readSelectedStoryGenerationPreset,
	saveSelectedStoryGenerationPreset,
} from "./modelSelection/modelSelectionStore";
import {
	getStoryGenerationPreset,
	type StoryGenerationPresetId,
} from "./models";
import {
	deleteSavedStory,
	findUnfinishedReadingSave,
	listSavedStories,
	type SavedStorySummary,
} from "./saves";
import {
	backgroundLayerStyle,
	useBackgroundLayers,
} from "./story_session/background";
import { useStorySession } from "./story_session/useStorySession";

function parseAppPath(pathname: string): {
	languageId: LanguageId | null;
	storyId: string | null;
} {
	const parts = pathname.split("/").filter(Boolean);
	if (parts.length === 1 && isLanguageId(parts[0])) {
		return { languageId: parts[0], storyId: null };
	}
	if (
		parts.length === 3 &&
		isLanguageId(parts[0]) &&
		parts[1] === "story" &&
		parts[2]
	) {
		return { languageId: parts[0], storyId: parts[2] };
	}
	return { languageId: null, storyId: null };
}

export default function App() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const navigate = useNavigate();
	const parsedPath = parseAppPath(pathname);
	const languageId = parsedPath.languageId ?? readSelectedLanguage();

	useEffect(() => {
		syncLanguageDocument(languageId);
	}, [languageId]);

	useEffect(() => {
		if (pathname === "/") {
			void navigate({ to: `/${readSelectedLanguage()}`, replace: true });
			return;
		}
		if (!parsedPath.languageId) {
			void navigate({ to: `/${readSelectedLanguage()}`, replace: true });
		}
	}, [navigate, parsedPath.languageId, pathname]);

	function changeLanguage(nextLanguageId: LanguageId) {
		selectLanguage(nextLanguageId);
		void navigate({ to: `/${nextLanguageId}` });
	}

	return (
		<ReadingApp
			key={languageId}
			languageId={languageId}
			storyId={parsedPath.storyId}
			onLanguageChange={changeLanguage}
		/>
	);
}

function ReadingApp({
	languageId,
	storyId,
	onLanguageChange,
}: {
	languageId: LanguageId;
	storyId: string | null;
	onLanguageChange: (languageId: LanguageId) => void;
}) {
	const language = getLanguage(languageId);
	const navigate = useNavigate();
	const inStory = storyId !== null;
	const [savedStories, setSavedStories] = useState<SavedStorySummary[]>([]);
	const [savesError, setSavesError] = useState<string | null>(null);
	const [storyGenerationPresetId, setStoryGenerationPresetId] =
		useState<StoryGenerationPresetId>(readSelectedStoryGenerationPreset);
	const storyGeneration = getStoryGenerationPreset(storyGenerationPresetId);

	const refreshSavedStories = useCallback(async () => {
		try {
			setSavesError(null);
			setSavedStories(await listSavedStories(language.id));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setSavesError(`Could not read local saves: ${message}`);
		}
	}, [language.id]);

	useEffect(() => {
		void refreshSavedStories();
	}, [refreshSavedStories]);

	const sessionView: "menu" | "story" = inStory ? "story" : "menu";

	const languageSavedStories = savedStories.filter(
		(save) => save.genreId === language.id,
	);
	const unfinishedReadingSave = findUnfinishedReadingSave(languageSavedStories);

	const {
		activeSaveId,
		backToMenu,
		backgroundImage,
		backgroundIntro,
		completeStoryRecap,
		continueReadingStory,
		currentTarget,
		error,
		genre,
		openingAudio,
		openingAudioLoading,
		openingAudioError,
		retryOpeningAudio,
		phase,
		nonTranslatableWords,
		readingPartIndex,
		readingPreparationStatus,
		readingPreparationError,
		retryReadingPreparation,
		readingTotalParts,
		storyFeedbackSubmittedAt,
		storyFeedback,
		feedbackEditable,
		onStoryFeedbackDraftChange,
		retryStoryRecap,
		resumeStory,
		segments,
		skipStoryRecap,
		regenerateWordTranslation,
		startReadingStory,
		storyRecapError,
		storyRecapLesson,
		submitStoryFeedback,
		captureBotQuestions,
		wordTranslations,
	} = useStorySession({
		language,
		storyGeneration,
		view: sessionView,
		unfinishedReadingSaveId: unfinishedReadingSave?.id ?? null,
		onViewChange: (nextView, nextStoryId) => {
			if (nextView === "story" && nextStoryId) {
				void navigate({ to: `/${language.id}/story/${nextStoryId}` });
			} else if (nextView === "menu") {
				void navigate({ to: `/${language.id}` });
			}
		},
		onSavedStoriesChanged: refreshSavedStories,
		onSavesError: setSavesError,
	});

	useEffect(() => {
		if (storyId && !activeSaveId) void resumeStory(storyId);
	}, [activeSaveId, resumeStory, storyId]);

	const { visibleBackgroundUrl, previousBackgroundUrl, isBackgroundFading } =
		useBackgroundLayers(sessionView, backgroundImage);

	function handleStoryGenerationPresetChange(id: StoryGenerationPresetId) {
		saveSelectedStoryGenerationPreset(id);
		setStoryGenerationPresetId(id);
	}

	async function removeSavedStory(id: string) {
		try {
			setSavesError(null);
			await deleteSavedStory(id);
			await refreshSavedStories();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setSavesError(`Could not delete story: ${message}`);
		}
	}

	const showMainMenu = !inStory;
	const appClassName = `app${
		inStory && visibleBackgroundUrl ? " app--story-has-background" : ""
	}`;

	return (
		<div className={appClassName}>
			{inStory && visibleBackgroundUrl && (
				<>
					{previousBackgroundUrl && (
						<div
							className="story-background story-background--previous"
							style={backgroundLayerStyle(previousBackgroundUrl)}
						/>
					)}
					<div
						className={`story-background story-background--current${
							isBackgroundFading ? " story-background--fading" : ""
						}`}
						style={backgroundLayerStyle(visibleBackgroundUrl)}
					/>
				</>
			)}

			{inStory && (
				<header className="story-header">
					<h1>Story Reading</h1>
					<p className="subtitle">{genre?.label ?? ""}</p>
				</header>
			)}

			{showMainMenu && (
				<MainMenu
					language={language}
					savedStories={languageSavedStories}
					savesError={savesError}
					storyGenerationPreset={storyGenerationPresetId}
					onLanguageChange={onLanguageChange}
					onStoryGenerationPresetChange={handleStoryGenerationPresetChange}
					onStartReadingStory={
						unfinishedReadingSave
							? () => resumeStory(unfinishedReadingSave.id)
							: startReadingStory
					}
					hasUnfinishedReadingStory={Boolean(unfinishedReadingSave)}
					readingStoryStatus={readingPreparationStatus}
					readingStoryError={readingPreparationError}
					onRetryReadingStory={retryReadingPreparation}
					onResume={resumeStory}
					onDelete={removeSavedStory}
				/>
			)}

			{inStory && genre && (
				<ExerciseScreen
					language={language}
					segments={segments}
					currentTarget={currentTarget}
					phase={phase}
					error={error}
					backgroundIntro={backgroundIntro ?? undefined}
					storyId={activeSaveId}
					currentImageUrl={backgroundImage?.backgroundImageUrl ?? null}
					openingAudioUrl={openingAudio?.openingAudioUrl ?? null}
					openingAudioLoading={openingAudioLoading}
					openingAudioError={openingAudioError}
					onRetryOpeningAudio={retryOpeningAudio}
					readingPartIndex={readingPartIndex}
					readingTotalParts={readingTotalParts}
					storyFeedbackSubmittedAt={storyFeedbackSubmittedAt}
					storyFeedback={storyFeedback}
					feedbackEditable={feedbackEditable}
					wordTranslations={wordTranslations}
					nonTranslatableWords={nonTranslatableWords}
					storyRecapLesson={storyRecapLesson}
					storyRecapError={storyRecapError}
					onRegenerateWord={regenerateWordTranslation}
					onContinueReading={continueReadingStory}
					onCompleteStoryRecap={completeStoryRecap}
					onRetryStoryRecap={retryStoryRecap}
					onSkipStoryRecap={skipStoryRecap}
					onBackToMenu={backToMenu}
					onSubmitStoryFeedback={submitStoryFeedback}
					onStoryFeedbackDraftChange={onStoryFeedbackDraftChange}
					onCaptureBotQuestions={captureBotQuestions}
				/>
			)}
			{inStory && !genre && (
				<main className="story__error">
					{error ?? savesError ?? "Loading story…"}
				</main>
			)}
		</div>
	);
}
