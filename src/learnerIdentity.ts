/**
 * An anonymous learner identity: a random id the browser keeps in a cookie, so
 * the server can keep each visitor's adaptation state (settings, story memory,
 * word lookups, prepared next story) apart without accounts.
 *
 * The browser creates it before the first API call. A server-issued cookie
 * would race: the menu fires several requests at once, and each could come
 * back with a different id.
 */
export const LEARNER_COOKIE = "learner_id";

const learnerIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Browsers cap cookie lifetimes at 400 days; each visit renews it. */
const LEARNER_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export function isLearnerId(value: unknown): value is string {
	return typeof value === "string" && learnerIdPattern.test(value);
}

export function readCookie(
	cookieHeader: string | undefined,
	name: string,
): string | null {
	for (const part of cookieHeader?.split(";") ?? []) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() === name) {
			return decodeURIComponent(part.slice(separator + 1).trim());
		}
	}
	return null;
}

/** Keeps this browser's learner id in its cookie, creating it on first visit. */
export function ensureLearnerCookie(): void {
	const existing = readCookie(document.cookie, LEARNER_COOKIE);
	const learnerId = isLearnerId(existing) ? existing : crypto.randomUUID();
	const secure = location.protocol === "https:" ? "; Secure" : "";
	// biome-ignore lint/suspicious/noDocumentCookie: must be set synchronously before the first API request; the Cookie Store API is async and not universally available
	document.cookie = `${LEARNER_COOKIE}=${learnerId}; Path=/; Max-Age=${LEARNER_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}
