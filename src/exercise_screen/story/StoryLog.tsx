import type { StorySegment } from "../types";

interface StoryLogProps {
	segments: StorySegment[];
	onSelectSegment?: (index: number) => void;
}

export function StoryLog({ segments, onSelectSegment }: StoryLogProps) {
	if (segments.length === 0) return null;

	return (
		<div className="story__log">
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
