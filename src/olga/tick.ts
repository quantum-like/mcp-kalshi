import { type OlgaDecision, clockAfterDecision, decideOlga } from "./decide.js";
import type { ObservedIdentity } from "./decide.js";
import { readHostIdentity } from "./host-identity.js";
import { acquireHostLock } from "./lock.js";
import { loadOlgaState, saveClock } from "./state.js";

export const OLGA_DISABLED = true as const;

export async function runDisabledTick(input: {
	directory: string;
	nowMs: number;
	feedAtMs: number | null;
	exchangeNowMs: number | null;
	observed: ObservedIdentity;
	profile?: string;
}): Promise<OlgaDecision> {
	if (input.profile === "a2") {
		return {
			action: "STOP",
			reasons: ["Refusing to select the a2 profile."],
			submits: 0,
			retries: 0,
			freezeClock: false,
		};
	}
	const loaded = await loadOlgaState(input.directory);
	if (!loaded.ok) {
		return {
			action: "STOP",
			reasons: [loaded.reason],
			submits: 0,
			retries: 0,
			freezeClock: false,
		};
	}
	let lock: Awaited<ReturnType<typeof acquireHostLock>> | undefined;
	try {
		lock = await acquireHostLock(input.directory);
		await lock.assertBound();
	} catch (error) {
		await lock?.release();
		return {
			action: "STOP",
			reasons: [
				error instanceof Error
					? error.message
					: "Host lock failed. No fallback host is allowed.",
			],
			submits: 0,
			retries: 0,
			freezeClock: false,
		};
	}
	try {
		const again = await loadOlgaState(input.directory);
		if (!again.ok) {
			return {
				action: "STOP",
				reasons: [again.reason],
				submits: 0,
				retries: 0,
				freezeClock: false,
			};
		}
		let host: { machineId: string; home: string };
		try {
			host = readHostIdentity();
		} catch {
			return {
				action: "STOP",
				reasons: ["Host identity is unavailable. No fallback."],
				submits: 0,
				retries: 0,
				freezeClock: false,
			};
		}
		const decision = decideOlga(again.state, {
			nowMs: input.nowMs,
			feedAtMs: input.feedAtMs,
			exchangeNowMs: input.exchangeNowMs,
			host,
			observed: input.observed,
			profile: input.profile,
		});
		const nextClock = clockAfterDecision(
			again.state.clock,
			decision,
			input.nowMs,
			input.exchangeNowMs,
		);
		if (nextClock) {
			try {
				await lock.assertBound();
				await saveClock(input.directory, nextClock);
			} catch (error) {
				return {
					action: "STOP",
					reasons: [
						error instanceof Error
							? error.message
							: "State changed before it could be saved. No fallback.",
					],
					submits: 0,
					retries: 0,
					freezeClock: false,
				};
			}
		}
		return decision;
	} finally {
		await lock.release();
	}
}
