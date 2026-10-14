import type { IncomingMessage, ServerResponse } from "node:http";

/** An error whose status and message are safe to return to the client. */
export class HttpError extends Error {
	constructor(
		readonly statusCode: number,
		message: string,
		/** Extra JSON fields and response headers for the client. */
		readonly details: {
			body?: Record<string, unknown>;
			headers?: Record<string, string | number>;
		} = {},
	) {
		super(message);
	}
}

/** Generous for a whole story plus its glosses; anything larger is not ours. */
const MAX_BODY_BYTES = 512 * 1024;

export async function readBody(req: IncomingMessage) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) {
			throw new HttpError(413, "Request body is too large.");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads a JSON request body; an empty body reads as `{}`. Typed like
 * `JSON.parse` because every handler validates the fields it destructures.
 */
// biome-ignore lint/suspicious/noExplicitAny: untrusted JSON, validated per field by each handler
export async function readJsonBody(req: IncomingMessage): Promise<any> {
	const text = await readBody(req);
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, "Request body is not valid JSON.");
	}
}

export function sendJson(
	res: ServerResponse,
	statusCode: number,
	body: unknown,
) {
	res.statusCode = statusCode;
	if (body === null && statusCode === 204) {
		res.end();
		return;
	}
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}

export function sendBufferWithRangeSupport(
	req: IncomingMessage,
	res: ServerResponse,
	buffer: Buffer,
	contentType: string,
) {
	res.setHeader("Content-Type", contentType);
	res.setHeader("Accept-Ranges", "bytes");

	const range = req.headers.range;
	const match = typeof range === "string" && /^bytes=(\d*)-(\d*)$/.exec(range);
	if (!match) {
		res.statusCode = 200;
		res.setHeader("Content-Length", buffer.length);
		res.end(buffer);
		return;
	}

	const total = buffer.length;
	const start = match[1] ? Number(match[1]) : total - Number(match[2]);
	const end = match[2] && match[1] ? Number(match[2]) : total - 1;
	if (
		Number.isNaN(start) ||
		Number.isNaN(end) ||
		start > end ||
		start < 0 ||
		end >= total
	) {
		res.statusCode = 416;
		res.setHeader("Content-Range", `bytes */${total}`);
		res.end();
		return;
	}

	res.statusCode = 206;
	res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
	res.setHeader("Content-Length", end - start + 1);
	res.end(buffer.subarray(start, end + 1));
}
