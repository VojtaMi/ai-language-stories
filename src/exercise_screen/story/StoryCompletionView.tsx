import { useEffect, useState } from "react";
import { listStoryImages } from "../../gallery/galleryApi";
import type { StoryFeedbackRecord } from "../../storyFeedback";
import { StoryFeedbackForm } from "./StoryFeedbackForm";

interface StoryCompletionViewProps {
	storyId: string | null;
	currentImageUrl: string | null;
	readingTotalParts: number | null;
	storyFeedbackSubmittedAt: string | null;
	/** True only for a story just finished in this live session. */
	feedbackEditable: boolean;
	/** The prior feedback shown read-only when a finished save is reopened. */
	priorFeedback: string | null;
	canShowGallery: boolean;
	onOpenGallery: () => void;
	onSubmitStoryFeedback: (record: StoryFeedbackRecord) => void;
	onStoryFeedbackDraftChange: (record: StoryFeedbackRecord) => void;
}

export function StoryCompletionView({
	storyId,
	currentImageUrl,
	readingTotalParts,
	storyFeedbackSubmittedAt,
	feedbackEditable,
	priorFeedback,
	canShowGallery,
	onOpenGallery,
	onSubmitStoryFeedback,
	onStoryFeedbackDraftChange,
}: StoryCompletionViewProps) {
	const [firstImageUrl, setFirstImageUrl] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setFirstImageUrl(null);

		if (!canShowGallery || !storyId) return;

		listStoryImages(storyId)
			.then((urls) => {
				if (!cancelled) setFirstImageUrl(urls[0] ?? currentImageUrl);
			})
			.catch(() => {
				if (!cancelled) setFirstImageUrl(currentImageUrl);
			});

		return () => {
			cancelled = true;
		};
	}, [canShowGallery, storyId, currentImageUrl]);

	return (
		<div className="story-completion">
			<p className="story-practice__eyebrow">Story complete</p>
			<h2 className="story-practice__heading">Congratulations</h2>
			<p className="story-practice__lede">
				{readingTotalParts !== null
					? `You finished all ${readingTotalParts} parts.`
					: "You finished the whole story."}
			</p>

			<div className="story-completion__actions">
				{canShowGallery && (
					<button
						type="button"
						className="story-practice__choice story-practice__match-item"
						onClick={onOpenGallery}
					>
						Review gallery
					</button>
				)}
			</div>

			{canShowGallery && firstImageUrl && (
				<button
					type="button"
					className="story-completion__preview"
					onClick={onOpenGallery}
					aria-label="Review story image gallery"
				>
					<img src={firstImageUrl} alt="First story scene" />
				</button>
			)}

			{feedbackEditable ? (
				<>
					<hr className="story-practice__rule" />
					<StoryFeedbackForm
						key={storyId}
						onSubmit={onSubmitStoryFeedback}
						onDraftChange={onStoryFeedbackDraftChange}
						submitted={storyFeedbackSubmittedAt !== null}
					/>
				</>
			) : (
				priorFeedback && (
					<>
						<hr className="story-practice__rule" />
						<p className="story-practice__subheading">Your feedback</p>
						<p className="story-practice__paragraph">{priorFeedback}</p>
					</>
				)
			)}
		</div>
	);
}
