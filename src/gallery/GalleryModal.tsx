import { useEffect, useState } from "react";
import { listStoryImages } from "./galleryApi";

interface GalleryModalProps {
	storyId: string;
	currentImageUrl: string | null;
	onClose: () => void;
}

export function GalleryModal({
	storyId,
	currentImageUrl,
	onClose,
}: GalleryModalProps) {
	const [images, setImages] = useState<string[]>([]);
	const [index, setIndex] = useState(0);

	useEffect(() => {
		listStoryImages(storyId).then((urls) => {
			const all =
				urls.length > 0 ? urls : currentImageUrl ? [currentImageUrl] : [];
			setImages(all);
			// Open on the picture the learner is looking at, not the first one.
			const path = (url: string) => url.split("?")[0];
			const current = currentImageUrl
				? all.findIndex((url) => path(url) === path(currentImageUrl))
				: -1;
			setIndex(Math.max(current, 0));
		});
	}, [storyId, currentImageUrl]);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
			if (e.key === "ArrowRight") setIndex((i) => (i + 1) % images.length);
			if (e.key === "ArrowLeft")
				setIndex((i) => (i - 1 + images.length) % images.length);
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose, images.length]);

	if (images.length === 0) return null;

	function prev() {
		setIndex((i) => (i - 1 + images.length) % images.length);
	}

	function next() {
		setIndex((i) => (i + 1) % images.length);
	}

	return (
		<div className="gallery-overlay">
			<button
				type="button"
				className="gallery-backdrop"
				onClick={onClose}
				aria-label="Close gallery"
				tabIndex={-1}
			/>
			<div
				className="gallery-modal"
				role="dialog"
				aria-modal="true"
				aria-label="Image gallery"
			>
				<button
					type="button"
					className="gallery-close"
					onClick={onClose}
					aria-label="Close gallery"
				>
					✕
				</button>
				<img
					className="gallery-image"
					src={images[index]}
					alt={`Story scene ${index + 1} of ${images.length}`}
				/>
				<div className="gallery-nav">
					<button type="button" onClick={prev} aria-label="Previous image">
						←
					</button>
					<span className="gallery-counter">
						{index + 1} / {images.length}
					</span>
					<button type="button" onClick={next} aria-label="Next image">
						→
					</button>
				</div>
			</div>
		</div>
	);
}
