import type { NarrationSegment } from "../../storyAudio";

interface EstimatedWordTiming {
	offset: number;
	start: number;
	end: number;
}

// Relative weights keep this estimate independent of audio duration. Real
// alignment can later supply the same normalized intervals to wordAtTime.
export function estimateWordTimings(text: string): EstimatedWordTiming[] {
	const words = [...text.matchAll(/\p{L}+(?:[-’']\p{L}+)*/gu)];
	let total = 0;
	const timings = words.map((word, index) => {
		const gap = text.slice(
			word.index + word[0].length,
			words[index + 1]?.index ?? text.length,
		);
		const start = total;
		total +=
			Math.max(2, word[0].length) +
			(/[.!?…]/u.test(gap) ? 5 : /[,;:—]/u.test(gap) ? 2 : 0);
		return { offset: word.index, start, end: total };
	});
	return timings.map((word) => ({
		...word,
		start: word.start / total,
		end: word.end / total,
	}));
}

export function wordAtTime(
	timings: EstimatedWordTiming[],
	time: number,
	duration: number,
): number | null {
	if (
		!Number.isFinite(duration) ||
		duration <= 0 ||
		time < 0 ||
		time >= duration
	)
		return null;
	const progress = time / duration;
	return (
		timings.find((word) => progress >= word.start && progress < word.end)
			?.offset ?? null
	);
}

/**
 * The word being spoken at `time`. A recording stitched from several requests
 * carries their measured boundaries, so the length-based estimate runs inside
 * each segment and cannot drift across voices or the pauses between them.
 * During a pause, the segment's last word stays highlighted.
 */
export function narrationWordAtTime(
	text: string,
	time: number,
	duration: number,
	segments?: NarrationSegment[],
): number | null {
	if (!segments?.length) {
		return wordAtTime(estimateWordTimings(text), time, duration);
	}
	if (!Number.isFinite(duration) || time < 0 || time >= duration) return null;
	let segment: NarrationSegment | undefined;
	for (const candidate of segments) {
		if (time >= candidate.start) segment = candidate;
	}
	if (!segment) return null;
	const spoken = segment.end - segment.start;
	const local = Math.min(time - segment.start, spoken * 0.999);
	const offset = wordAtTime(
		estimateWordTimings(text.slice(segment.textStart, segment.textEnd)),
		local,
		spoken,
	);
	return offset === null ? null : segment.textStart + offset;
}
