import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface RateLimitRule {
	name: string;
	limit: number;
	windowMs: number;
}

export interface RateLimitResult {
	allowed: boolean;
	retryAfterSeconds: number;
	blockedBy: string[];
}

interface Counter {
	count: number;
	resetAt: number;
}

export class InMemoryRateLimiter {
	private readonly counters = new Map<string, Counter>();

	consume(
		identifier: string,
		rules: readonly RateLimitRule[],
		now = Date.now(),
	): RateLimitResult {
		const activeCounters = rules.map((rule) => {
			const key = `${rule.name}:${identifier}`;
			const existing = this.counters.get(key);
			const counter =
				existing && existing.resetAt > now
					? existing
					: { count: 0, resetAt: now + rule.windowMs };
			return { key, rule, counter };
		});

		const exceeded = activeCounters.filter(
			({ counter, rule }) => counter.count >= rule.limit,
		);
		if (exceeded.length > 0) {
			return {
				allowed: false,
				blockedBy: exceeded.map(({ rule }) => rule.name),
				retryAfterSeconds: Math.max(
					1,
					...exceeded.map(({ counter }) =>
						Math.ceil((counter.resetAt - now) / 1_000),
					),
				),
			};
		}

		for (const { key, counter } of activeCounters) {
			counter.count += 1;
			this.counters.set(key, counter);
		}
		return { allowed: true, retryAfterSeconds: 0, blockedBy: [] };
	}
}

export function isOwnerToken(candidate: string | undefined, expected: string) {
	if (!candidate || !expected) return false;
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(candidate), digest(expected));
}

export function providerRateLimitRules(
	isStoryPreparation: boolean,
	ownerCanSkipDailyLimit: boolean,
	burstRule: RateLimitRule,
	storyDailyRule: RateLimitRule,
): RateLimitRule[] {
	return isStoryPreparation && !ownerCanSkipDailyLimit
		? [burstRule, storyDailyRule]
		: [burstRule];
}

export function getClientIdentifier(req: IncomingMessage, trustProxy: boolean) {
	if (trustProxy) {
		const forwardedFor = req.headers["x-forwarded-for"];
		const firstAddress = (
			Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor
		)
			?.split(",")[0]
			?.trim();
		if (firstAddress) return firstAddress;
	}

	return req.socket.remoteAddress ?? "unknown";
}
