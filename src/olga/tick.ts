import { join } from "node:path";
import { type OlgaDecision, decideOlga } from "./decide.js";
import type { ObservedIdentity } from "./decide.js";
import { acquireHostLock } from "./lock.js";
import { loadOlgaState, saveClock } from "./state.js";

export const OLGA_DISABLED = true as const;

export async function runDisabledTick(input: {
	directory: string;
	nowMs: number;
	feedAtMs: number | null;
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
	const lock = await acquireHostLock(join(input.directory, "olga-host.lock"));
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
		const decision = decideOlga(again.state, input);
		if (decision.freezeClock) {
			await saveClock(input.directory, {
				...again.state.clock,
				frozen: true,
				freezeReason: decision.reasons[0] ?? "halt",
			});
		}
		return decision;
	} finally {
		await lock.release();
	}
}
