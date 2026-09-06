import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import {
	getClientIdentifier,
	InMemoryRateLimiter,
	isOwnerToken,
	providerRateLimitRules,
	type RateLimitRule,
} from "../src/server/rateLimit";

const limiter = new InMemoryRateLimiter();
const minuteRule: RateLimitRule = {
	name: "minute",
	limit: 2,
	windowMs: 60_000,
};
const dailyRule: RateLimitRule = {
	name: "daily",
	limit: 1,
	windowMs: 86_400_000,
};

assert.equal(limiter.consume("visitor-a", [minuteRule], 1_000).allowed, true);
assert.equal(limiter.consume("visitor-a", [minuteRule], 1_000).allowed, true);
const blocked = limiter.consume("visitor-a", [minuteRule], 1_000);
assert.equal(blocked.allowed, false);
assert.equal(blocked.retryAfterSeconds, 60);
assert.deepEqual(blocked.blockedBy, ["minute"]);
assert.equal(limiter.consume("visitor-b", [minuteRule], 1_000).allowed, true);
assert.equal(limiter.consume("visitor-a", [minuteRule], 61_000).allowed, true);

const combinedLimiter = new InMemoryRateLimiter();
assert.equal(
	combinedLimiter.consume("visitor", [minuteRule, dailyRule], 1_000).allowed,
	true,
);
assert.equal(
	combinedLimiter.consume("visitor", [minuteRule, dailyRule], 1_000).allowed,
	false,
);
assert.equal(
	combinedLimiter.consume("visitor", [minuteRule], 1_000).allowed,
	true,
);

assert.equal(isOwnerToken("owner-secret", "owner-secret"), true);
assert.equal(isOwnerToken("wrong-secret", "owner-secret"), false);
assert.equal(isOwnerToken(undefined, "owner-secret"), false);
assert.equal(isOwnerToken("owner-secret", ""), false);

assert.deepEqual(providerRateLimitRules(true, false, minuteRule, dailyRule), [
	minuteRule,
	dailyRule,
]);
assert.deepEqual(providerRateLimitRules(true, true, minuteRule, dailyRule), [
	minuteRule,
]);
assert.deepEqual(providerRateLimitRules(false, true, minuteRule, dailyRule), [
	minuteRule,
]);

const request = {
	headers: { "x-forwarded-for": "203.0.113.8, 10.0.0.2" },
	socket: { remoteAddress: "127.0.0.1" },
} as IncomingMessage;
assert.equal(getClientIdentifier(request, false), "127.0.0.1");
assert.equal(getClientIdentifier(request, true), "203.0.113.8");

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;
let capturedHeaders: HeadersInit | undefined;
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: {
		getItem: (key: string) =>
			key === "language-stories.owner-token" ? "browser-owner-secret" : null,
	},
});
globalThis.fetch = async (_input, init) => {
	capturedHeaders = init?.headers;
	return new Response("[]", {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};
try {
	const { prepareMissingReadingOpenings } = await import("../src/openings");
	await prepareMissingReadingOpenings("esperanto");
	assert.equal(
		(capturedHeaders as Record<string, string>)["X-Owner-Token"],
		"browser-owner-secret",
	);
} finally {
	globalThis.fetch = originalFetch;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: originalLocalStorage,
	});
}

console.log("Rate-limit tests passed.");
