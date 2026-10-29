import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

type AiTraceContext = {
	requestId: string;
	method: string;
	pathname: string;
	metadata?: Record<string, unknown>;
};

type AiTraceCall = {
	kind: string;
	provider: "anthropic" | "gemini" | "openai";
	model: string;
	stream?: boolean;
	input?: unknown;
	output?: unknown;
	metadata?: Record<string, unknown>;
};

type AiTraceRecord = {
	timestamp: string;
	requestId?: string;
	method?: string;
	pathname?: string;
	kind: string;
	provider: AiTraceCall["provider"];
	model: string;
	stream: boolean;
	durationMs: number;
	ok: boolean;
	input?: AiTracePayloadSummary;
	output?: AiTracePayloadSummary;
	metadata?: Record<string, unknown>;
	/** The provider's token accounting, as reported, for cost estimates. */
	usage?: unknown;
	error?: {
		name: string;
		message: string;
		details?: AiTracePayloadSummary;
	};
};

type AiTracePayloadSummary = {
	chars?: number;
	items?: number;
	preview?: string;
	value?: unknown;
};

export class AiTraceError extends Error {
	constructor(
		message: string,
		readonly details: unknown,
	) {
		super(message);
		this.name = "AiTraceError";
	}
}

const traceContext = new AsyncLocalStorage<AiTraceContext>();
let traceLogInit: Promise<void> | null = null;
const pendingTraceWrites = new Set<Promise<void>>();

export function createAiTraceContext(method: string, pathname: string) {
	return {
		requestId: randomUUID(),
		method,
		pathname,
	};
}

export function withAiTraceContext<T>(
	context: AiTraceContext,
	work: () => T,
): T {
	return traceContext.run(context, work);
}

/** Adds request-specific context to every provider call made in this scope. */
export function withAiTraceMetadata<T>(
	metadata: Record<string, unknown>,
	work: () => T,
): T {
	const context = traceContext.getStore();
	if (!context) return work();
	return traceContext.run(
		{ ...context, metadata: { ...context.metadata, ...metadata } },
		work,
	);
}

export async function traceAiCall<T>(
	call: AiTraceCall,
	work: () => Promise<T>,
	output?: (value: T) => unknown,
): Promise<T> {
	const start = performance.now();
	try {
		const value = await work();
		const usage = usageOf(value);
		queueTraceRecord({
			...baseRecord(call, start),
			ok: true,
			output: summarizePayload(output ? output(value) : call.output),
			...(usage ? { usage } : {}),
		});
		return value;
	} catch (err) {
		queueTraceRecord({
			...baseRecord(call, start),
			ok: false,
			error: errorSummary(err),
		});
		throw err;
	}
}

/** OpenAI and Anthropic report `usage`; Gemini reports `usageMetadata`. */
function usageOf(value: unknown): unknown {
	if (!value || typeof value !== "object") return undefined;
	const record = value as { usage?: unknown; usageMetadata?: unknown };
	return record.usage ?? record.usageMetadata;
}

function baseRecord(
	call: AiTraceCall,
	start: number,
): Omit<AiTraceRecord, "ok"> {
	const context = traceContext.getStore();
	const metadata = { ...context?.metadata, ...call.metadata };
	return {
		timestamp: new Date().toISOString(),
		requestId: context?.requestId,
		method: context?.method,
		pathname: context?.pathname,
		kind: call.kind,
		provider: call.provider,
		model: call.model,
		stream: Boolean(call.stream),
		durationMs: Math.round(performance.now() - start),
		input: summarizePayload(call.input),
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	};
}

async function writeTraceRecord(record: AiTraceRecord) {
	if (!aiTraceEnabled()) return;
	try {
		await initializeTraceLog();
		await appendFile(traceFilePath(), `${JSON.stringify(record)}\n`, "utf8");
	} catch (err) {
		console.warn("Could not write AI trace log.", err);
	}
}

function queueTraceRecord(record: AiTraceRecord) {
	const write = writeTraceRecord(record).finally(() => {
		pendingTraceWrites.delete(write);
	});
	pendingTraceWrites.add(write);
}

/** Wait until every provider call recorded so far is durable on disk. */
export async function flushAiTraceLog(): Promise<void> {
	await Promise.all([...pendingTraceWrites]);
}

function initializeTraceLog() {
	traceLogInit ??= (async () => {
		const path = traceFilePath();
		await mkdir(dirname(path), { recursive: true });
		if (process.env.AI_CALL_LOG_APPEND === "1") return;
		await writeFile(path, "", "utf8");
	})();
	return traceLogInit;
}

function traceFilePath() {
	const configured = process.env.AI_CALL_LOG_PATH?.trim();
	if (!configured) return join(process.cwd(), "logs", "ai-calls.ndjson");
	return isAbsolute(configured) ? configured : join(process.cwd(), configured);
}

function aiTraceEnabled() {
	return process.env.AI_CALL_LOG === "1" || process.env.AI_TRACE === "1";
}

function summarizePayload(value: unknown): AiTracePayloadSummary | undefined {
	if (value === undefined) return undefined;
	if (process.env.AI_CALL_LOG_PAYLOAD === "full") {
		return { value };
	}
	if (typeof value === "string") {
		return {
			chars: value.length,
			preview: value.slice(0, 500),
		};
	}
	if (Array.isArray(value)) {
		return {
			chars: JSON.stringify(value).length,
			items: value.length,
			preview: JSON.stringify(value).slice(0, 500),
		};
	}
	if (value && typeof value === "object") {
		const json = JSON.stringify(value);
		return {
			chars: json.length,
			preview: json.slice(0, 500),
		};
	}
	return { value };
}

function errorSummary(err: unknown) {
	if (err instanceof Error) {
		const details =
			err instanceof AiTraceError ? summarizePayload(err.details) : undefined;
		return {
			name: err.name,
			message: err.message,
			details,
		};
	}
	return {
		name: "Error",
		message: String(err),
	};
}
