import type { StorySegment } from "../types";

interface StoryLogProps {
	segments: StorySegment[];
	onSelectSegment?: (index: number) => void;
	/** BCP 47 tag of the story language. */
	lang: string;
}

export function StoryLog({ segments, onSelectSegment, lang }: StoryLogProps) {
	if (segments.length === 0) return null;

	return (
		<div className="story__log" lang={lang}>
			{segments.map((segment, index) => (
				<p key={segment.id} className={`segment segment--${segment.author}`}>
					{onSelectSegment ? (
						<button
							type="button"
							className="segment__select"
							onClick={() => onSelectSegment(index)}
						>
							{segment.text}
						</button>
					) : (
						segment.text
					)}
				</p>
			))}
		</div>
	);
}
