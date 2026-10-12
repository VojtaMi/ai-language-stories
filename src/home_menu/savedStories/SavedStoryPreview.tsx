import { languages } from "../../languages";
import type { SavedStorySummary } from "../../saves";

interface SavedStoryPreviewProps {
	story: SavedStorySummary;
	onResume: (id: string) => void;
	onDelete: (id: string) => void;
}

export function SavedStoryPreview({
	story,
	onResume,
	onDelete,
}: SavedStoryPreviewProps) {
	const storyGenre = languages.find((genre) => genre.id === story.genreId);

	return (
		<article className="saved-story">
			<div>
				<h3>{story.title}</h3>
				<p className="saved-story__meta">
					{storyGenre?.label ?? story.genreId} · {formatDate(story.createdAt)}
				</p>
				{story.preview && (
					<p className="saved-story__preview">{story.preview}</p>
				)}
			</div>
			<div className="saved-story__actions">
				<button type="button" onClick={() => onResume(story.id)}>
					Resume
				</button>
				<button
					type="button"
					className="saved-story__delete"
					onClick={() => onDelete(story.id)}
				>
					Delete
				</button>
			</div>
		</article>
	);
}

function formatDate(value: string) {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}
