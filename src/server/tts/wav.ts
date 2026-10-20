export function pcmToWav(pcm: Buffer, sampleRate = 24_000): Buffer {
	const channels = 1;
	const bitsPerSample = 16;
	const byteRate = (sampleRate * channels * bitsPerSample) / 8;
	const blockAlign = (channels * bitsPerSample) / 8;
	const header = Buffer.alloc(44);

	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bitsPerSample, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);

	return Buffer.concat([header, pcm]);
}

/** The 16-bit PCM samples and sample rate of a WAV file, or null if it is not one. */
export function readWav(
	wav: Buffer,
): { pcm: Buffer; sampleRate: number } | null {
	if (
		wav.toString("ascii", 0, 4) !== "RIFF" ||
		wav.toString("ascii", 8, 12) !== "WAVE"
	) {
		return null;
	}
	let sampleRate = 0;
	let bitsPerSample = 0;
	let channels = 0;
	for (let offset = 12; offset + 8 <= wav.length; ) {
		const id = wav.toString("ascii", offset, offset + 4);
		const size = wav.readUInt32LE(offset + 4);
		const start = offset + 8;
		if (id === "fmt ") {
			channels = wav.readUInt16LE(start + 2);
			sampleRate = wav.readUInt32LE(start + 4);
			bitsPerSample = wav.readUInt16LE(start + 14);
		} else if (id === "data") {
			if (!sampleRate || bitsPerSample !== 16 || channels !== 1) return null;
			return {
				pcm: wav.subarray(start, Math.min(start + size, wav.length)),
				sampleRate,
			};
		}
		offset = start + size + (size % 2);
	}
	return null;
}
