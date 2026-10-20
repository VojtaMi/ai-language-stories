/** Loudness is measured over 10 ms frames. */
const FRAME_MS = 10;
/**
 * Quiet this long separates two words. Gemini is asked for about a second of
 * silence between words, and gaps inside a word are far shorter.
 */
const MIN_GAP_MS = 350;
/** Shorter sounds are breaths or clicks; the shortest measured word is ~290 ms. */
const MIN_WORD_MS = 200;
/** Kept around each word so soft onsets and endings are not clipped. */
const PAD_MS = 60;

/**
 * Cuts a recording of words read one per line into one clip per word, at the
 * silences between them. Returns null unless it finds exactly `count` words:
 * a clip under the wrong word is worse than no clip.
 */
export function splitWordRecording(
	pcm: Buffer,
	sampleRate: number,
	count: number,
): Buffer[] | null {
	const frameSamples = Math.round((sampleRate * FRAME_MS) / 1000);
	const levels: number[] = [];
	for (
		let offset = 0;
		offset + frameSamples * 2 <= pcm.length;
		offset += frameSamples * 2
	) {
		let sum = 0;
		for (let i = 0; i < frameSamples; i++) {
			const sample = pcm.readInt16LE(offset + i * 2) / 32768;
			sum += sample * sample;
		}
		levels.push(Math.sqrt(sum / frameSamples));
	}

	// Relative to the recording's own loudness, so voice and volume don't matter.
	const loud = [...levels].sort((a, b) => a - b)[
		Math.floor(levels.length * 0.95)
	];
	const threshold = Math.max((loud ?? 0) * 0.05, 0.003);
	const minGapFrames = MIN_GAP_MS / FRAME_MS;
	const words: [number, number][] = [];
	let start = -1;
	let quiet = 0;
	levels.forEach((level, frame) => {
		if (level > threshold) {
			if (start < 0) start = frame;
			quiet = 0;
		} else if (start >= 0 && ++quiet >= minGapFrames) {
			words.push([start, frame - quiet + 1]);
			start = -1;
			quiet = 0;
		}
	});
	if (start >= 0) words.push([start, levels.length - quiet]);

	const spoken = words.filter(
		([from, to]) => (to - from) * FRAME_MS >= MIN_WORD_MS,
	);
	if (spoken.length !== count) return null;

	const padFrames = PAD_MS / FRAME_MS;
	const frameBytes = frameSamples * 2;
	return spoken.map(([from, to]) =>
		Buffer.from(
			pcm.subarray(
				Math.max(0, from - padFrames) * frameBytes,
				Math.min(levels.length, to + padFrames) * frameBytes,
			),
		),
	);
}
