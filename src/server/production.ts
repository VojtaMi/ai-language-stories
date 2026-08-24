import { readFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { isLanguageId, type LanguageId } from "../languages";
import { TEXT_REASONING_EFFORTS, type TextReasoningEffort } from "../models";
import { DEFAULT_TTS_MODEL, isTtsModelId } from "../ttsModel";
import {
	handleBackgroundImageRequest,
	handleCompleteRequest,
	handleFinalizeStoryEvidenceRequest,
	handleLearnerPreferencesUpdateRequest,
	handleLearnerProfileGetRequest,
	handleLearnerWordLogRequest,
	handleOpeningAudioRequest,
	handleRegenerateWordAudioRequest,
	handleRegenerateWordRequest,
	handleWordAudioRequest,
} from "./aiEndpointHandlers";
import { createAiTraceContext, withAiTraceContext } from "./aiTrace";
import { readBody, sendBufferWithRangeSupport, sendJson } from "./http";
import {
	consumePreparedReadingOpening,
	findLanguage,
	imageFilePattern,
	listPreparedReadingOpenings,
	listStoryImages,
	prepareMissingReadingOpenings,
	readStoryImage,
} from "./openingsStore";
import {
	deleteSave,
	listSaves,
	readSave,
	saveIdPattern,
	writeSave,
} from "./savesStore";
import { audioFilePattern, readStoryAudio } from "./storyAudioStore";
import { readWordAudio, wordFilePattern } from "./wordAudioStore";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT) || 80;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const distDir = join(__dirname, "dist");

// Keep the API server available without local credentials so the client can
// show a useful setup message instead of failing during server startup.
const openai = new OpenAI({ apiKey: OPENAI_API_KEY || "missing-openai-key" });
const prepareReadingPromises = new Map<LanguageId, Promise<void>>();

const mimeTypes: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript",
	".mjs": "application/javascript",
	".css": "text/css",
	".webp": "image/webp",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".json": "application/json",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
};

async function serveStatic(
	res: Parameters<typeof sendJson>[0],
	urlPath: string,
) {
	const filePath = join(distDir, urlPath === "/" ? "index.html" : urlPath);
	try {
		const content = await readFile(filePath);
		const mime = mimeTypes[extname(filePath)] ?? "application/octet-stream";
		res.setHeader("Content-Type", mime);
		res.statusCode = 200;
		res.end(content);
	} catch {
		try {
			const content = await readFile(join(distDir, "index.html"));
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.statusCode = 200;
			res.end(content);
		} catch {
			res.statusCode = 404;
			res.end("Not found");
		}
	}
}

function imageMimeType(path: string) {
	if (path.endsWith(".png")) return "image/png";
	if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
	return "image/webp";
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	const context = createAiTraceContext(req.method ?? "GET", url.pathname);
	await withAiTraceContext(context, () => handleRequest(req, res, url));
});

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
) {
	const pathname = url.pathname;
	const parts = pathname.split("/").filter(Boolean);

	try {
		if (pathname === "/api/reading-openings" && req.method === "GET") {
			const languageId = url.searchParams.get("language");
			if (!isLanguageId(languageId)) {
				sendJson(res, 400, { error: "language is invalid." });
				return;
			}
			sendJson(res, 200, await listPreparedReadingOpenings(languageId));
			return;
		}

		if (pathname === "/api/provider-availability" && req.method === "GET") {
			sendJson(res, 200, {
				openai: Boolean(OPENAI_API_KEY.trim()),
				gemini: Boolean((process.env.GEMINI_API_KEY ?? "").trim()),
				anthropic: Boolean(ANTHROPIC_API_KEY.trim()),
			});
			return;
		}

		if (pathname === "/api/reading-openings/prepare" && req.method === "POST") {
			const body = req.headers["content-length"]
				? JSON.parse(await readBody(req))
				: {};
			if (!isLanguageId(body.genreId)) {
				sendJson(res, 400, { error: "genreId is invalid." });
				return;
			}
			if (
				body.reasoningEffort !== undefined &&
				!TEXT_REASONING_EFFORTS.includes(
					body.reasoningEffort as TextReasoningEffort,
				)
			) {
				sendJson(res, 400, { error: "reasoningEffort is invalid." });
				return;
			}
			let preparation = prepareReadingPromises.get(body.genreId);
			preparation ??= prepareMissingReadingOpenings(
				openai,
				body.genreId,
				body.model,
				ANTHROPIC_API_KEY,
				body.basedOnStoryId ?? null,
				typeof body.nextTheme === "string" ? body.nextTheme : undefined,
				body.reasoningEffort as TextReasoningEffort | undefined,
				isTtsModelId(body.ttsModel) ? body.ttsModel : DEFAULT_TTS_MODEL,
			).finally(() => {
				prepareReadingPromises.delete(body.genreId);
			});
			prepareReadingPromises.set(body.genreId, preparation);
			await preparation;
			sendJson(res, 200, await listPreparedReadingOpenings(body.genreId));
			return;
		}

		if (
			parts.length === 4 &&
			parts[0] === "api" &&
			parts[1] === "reading-openings" &&
			parts[3] === "consume" &&
			req.method === "POST"
		) {
			const genreId = parts[2];
			if (!genreId || !findLanguage(genreId)) {
				sendJson(res, 404, { error: "Language not found." });
				return;
			}
			const cached = await consumePreparedReadingOpening(genreId as LanguageId);
			if (cached) {
				sendJson(res, 200, cached);
				return;
			}
			const preparation = prepareReadingPromises.get(genreId as LanguageId);
			if (preparation) await preparation;
			sendJson(
				res,
				200,
				await consumePreparedReadingOpening(genreId as LanguageId),
			);
			return;
		}

		if (
			parts[0] === "api" &&
			parts[1] === "story-images" &&
			req.method === "GET"
		) {
			const storyIdPattern = /^[a-zA-Z0-9_-]+$/;
			const imageParts = parts.slice(2);
			let relativePath: string;
			if (imageParts.length === 1) {
				const filename = decodeURIComponent(imageParts[0] ?? "");
				if (!imageFilePattern.test(filename)) {
					sendJson(res, 404, { error: "Image not found." });
					return;
				}
				relativePath = filename;
			} else if (imageParts.length === 2) {
				const storyId = decodeURIComponent(imageParts[0] ?? "");
				const filename = decodeURIComponent(imageParts[1] ?? "");
				if (!storyIdPattern.test(storyId) || !imageFilePattern.test(filename)) {
					sendJson(res, 404, { error: "Image not found." });
					return;
				}
				relativePath = `${storyId}/${filename}`;
			} else {
				sendJson(res, 404, { error: "Image not found." });
				return;
			}
			try {
				const file = await readStoryImage(relativePath);
				res.statusCode = 200;
				res.setHeader("Content-Type", imageMimeType(relativePath));
				res.setHeader("Cache-Control", "no-store");
				res.end(file);
			} catch {
				sendJson(res, 404, { error: "Image not found." });
			}
			return;
		}

		if (
			parts[0] === "api" &&
			parts[1] === "story-audio" &&
			req.method === "GET"
		) {
			const storyIdPattern = /^[a-zA-Z0-9_-]+$/;
			const audioParts = parts.slice(2);
			if (audioParts.length !== 2) {
				sendJson(res, 404, { error: "Audio not found." });
				return;
			}
			const storyId = decodeURIComponent(audioParts[0] ?? "");
			const filename = decodeURIComponent(audioParts[1] ?? "");
			if (!storyIdPattern.test(storyId) || !audioFilePattern.test(filename)) {
				sendJson(res, 404, { error: "Audio not found." });
				return;
			}
			try {
				const file = await readStoryAudio(`${storyId}/${filename}`);
				res.setHeader("Cache-Control", "no-store");
				sendBufferWithRangeSupport(
					req,
					res,
					file,
					filename.endsWith(".wav") ? "audio/wav" : "audio/mpeg",
				);
			} catch {
				sendJson(res, 404, { error: "Audio not found." });
			}
			return;
		}

		if (
			parts.length === 3 &&
			parts[0] === "api" &&
			parts[1] === "gallery" &&
			req.method === "GET"
		) {
			const storyId = decodeURIComponent(parts[2] ?? "");
			if (!storyId || !saveIdPattern.test(storyId)) {
				sendJson(res, 404, { error: "Story not found." });
				return;
			}
			sendJson(res, 200, await listStoryImages(storyId));
			return;
		}

		if (pathname === "/api/saves" && req.method === "GET") {
			const languageId = url.searchParams.get("language");
			if (languageId !== null && !isLanguageId(languageId)) {
				sendJson(res, 400, { error: "language is invalid." });
				return;
			}
			const saves = await listSaves();
			sendJson(
				res,
				200,
				languageId
					? saves.filter((save) => save.genreId === languageId)
					: saves,
			);
			return;
		}

		if (parts.length === 3 && parts[0] === "api" && parts[1] === "saves") {
			const id = parts[2];
			if (!id || !saveIdPattern.test(id)) {
				sendJson(res, 404, { error: "Save not found." });
				return;
			}

			if (req.method === "GET") {
				const save = await readSave(id);
				if (!save) {
					sendJson(res, 404, { error: "Save not found." });
					return;
				}
				sendJson(res, 200, save);
				return;
			}

			if (req.method === "PUT") {
				const save = JSON.parse(await readBody(req));
				if (save.id !== id) {
					sendJson(res, 400, { error: "Save id does not match URL." });
					return;
				}
				await writeSave(id, save);
				sendJson(res, 200, save);
				return;
			}

			if (req.method === "DELETE") {
				await deleteSave(id);
				sendJson(res, 204, null);
				return;
			}

			sendJson(res, 405, { error: "Method not allowed." });
			return;
		}

		if (pathname === "/api/learner-profile" && req.method === "GET") {
			await handleLearnerProfileGetRequest(req, res);
			return;
		}

		if (
			pathname === "/api/learner-profile/preferences" &&
			req.method === "PUT"
		) {
			await handleLearnerPreferencesUpdateRequest(req, res);
			return;
		}

		if (pathname === "/api/learner-profile/word-log" && req.method === "POST") {
			await handleLearnerWordLogRequest(req, res);
			return;
		}

		if (
			pathname === "/api/learner-profile/finalize-story" &&
			req.method === "POST"
		) {
			await handleFinalizeStoryEvidenceRequest(
				req,
				res,
				openai,
				ANTHROPIC_API_KEY,
			);
			return;
		}

		if (pathname === "/api/ai/complete" && req.method === "POST") {
			await handleCompleteRequest(req, res, openai, ANTHROPIC_API_KEY);
			return;
		}

		if (
			pathname === "/api/ai/translate-words/regenerate" &&
			req.method === "POST"
		) {
			await handleRegenerateWordRequest(req, res, openai);
			return;
		}

		if (pathname === "/api/word-audio/regenerate" && req.method === "POST") {
			await handleRegenerateWordAudioRequest(req, res, openai);
			return;
		}

		if (pathname === "/api/word-audio" && req.method === "POST") {
			await handleWordAudioRequest(req, res, openai);
			return;
		}

		if (
			parts.length === 4 &&
			parts[0] === "api" &&
			parts[1] === "word-audio" &&
			req.method === "GET"
		) {
			const languageId = parts[2];
			const word = decodeURIComponent(parts[3] ?? "");
			if (
				!isLanguageId(languageId) ||
				!word ||
				!wordFilePattern.test(`${word}.mp3`)
			) {
				sendJson(res, 404, { error: "Audio not found." });
				return;
			}
			try {
				const file = await readWordAudio(languageId, word);
				res.statusCode = 200;
				res.setHeader("Content-Type", file.mimeType);
				res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
				res.end(file.audio);
			} catch {
				sendJson(res, 404, { error: "Audio not found." });
			}
			return;
		}

		if (pathname === "/api/ai/opening-audio" && req.method === "POST") {
			await handleOpeningAudioRequest(req, res, openai);
			return;
		}

		if (pathname === "/api/ai/background-image" && req.method === "POST") {
			await handleBackgroundImageRequest(req, res, openai);
			return;
		}

		await serveStatic(res, pathname);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(err);
		sendJson(res, 500, { error: message });
	}
}

server.listen(PORT, () => {
	console.log(`Listening on port ${PORT}`);
});
