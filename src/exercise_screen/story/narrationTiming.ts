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
