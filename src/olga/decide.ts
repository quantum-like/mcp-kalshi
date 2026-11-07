import {
	A1_KEYCHAIN_SERVICE,
	OLGA_HOST_ID,
	type OlgaState,
	POLICY_GATES,
	SEALED_POLICY_IDS,
} from "./state.js";

export const MAX_FEED_AGE_MS = 15_000;
export const MAX_AWAKE_GAP_MS = 60_000;
export const MAX_CLOCK_BACK_MS = 1_000;

export interface ObservedIdentity {
	apiKeyId: string | null;
	memberId: string | null;
	subaccount: number | null;
	keyPresent: boolean | null;
	keychainService: string | null;
	readsComplete: boolean;
}

export interface OlgaDecision {
	action: "WAIT" | "STOP";
	reasons: string[];
	submits: 0;
	retries: 0;
	freezeClock: boolean;
}

export function decideOlga(
	state: OlgaState,
	input: {
		nowMs: number;
		feedAtMs: number | null;
		observed: ObservedIdentity;
		profile?: string;
	},
): OlgaDecision {
	if (input.profile === "a2") {
		return stop("Refusing to select the a2 profile.");
	}
	if (
		state.owner.hostId !== OLGA_HOST_ID ||
		state.owner.fallback !== "forbidden" ||
		state.owner.profile !== "a1"
	) {
		return stop("Host ownership does not match Olga. No automatic fallback.");
	}
	const identity = checkIdentity(state, input.observed);
	if (!identity.ok) return stop(identity.reason);
	const fresh = checkFreshness(state, input.nowMs, input.feedAtMs);
	if (!fresh.ok) return stop(fresh.reason, fresh.freeze);
	if (state.risk.reservations.some((item) => item.state === "unknown")) {
		return stop(
			"Unknown order outcome stays reserved. No retry and no new order.",
		);
	}
	if (state.risk.reservations.some((item) => item.state === "submitting")) {
		return stop("Orphan submitting order. STOP. No retry and no fallback.");
	}
	if (state.policy.liveLearning !== false) {
		return stop("Live learning is forbidden.");
	}
	const sealed =
		(SEALED_POLICY_IDS as readonly string[]).includes(state.policy.policyId) &&
		POLICY_GATES.every((gate) => state.policy.gates[gate] === true);
	if (sealed) {
		return stop(
			"This build has no order path. A sealed policy still cannot trade.",
		);
	}
	return {
		action: "WAIT",
		reasons: [
			state.policy.policyId === "unvalidated"
				? "No qualified policy is sealed in this build. Decision is WAIT. This is not a profitability claim."
				: "Policy is unknown or unvalidated. Decision is WAIT. No trading policy was invented.",
		],
		submits: 0,
		retries: 0,
		freezeClock: false,
	};
}

export function policyWaits(state: OlgaState): boolean {
	const sealed =
		(SEALED_POLICY_IDS as readonly string[]).includes(state.policy.policyId) &&
		POLICY_GATES.every((gate) => state.policy.gates[gate] === true);
	return !sealed;
}

function checkIdentity(
	state: OlgaState,
	observed: ObservedIdentity,
): { ok: true } | { ok: false; reason: string } {
	if (observed.keyPresent !== true) {
		return {
			ok: false,
			reason: "a1 Keychain item is missing or unknown. Fail closed.",
		};
	}
	if (observed.keychainService !== A1_KEYCHAIN_SERVICE) {
		return {
			ok: false,
			reason: "Keychain service is not the separate a1 item.",
		};
	}
	const binding = state.binding;
	if (
		!binding.bound ||
		binding.apiKeyId === null ||
		binding.memberId === null ||
		binding.subaccount === null
	) {
		return {
			ok: false,
			reason: "Authenticated account binding is incomplete.",
		};
	}
	if (!observed.readsComplete) {
		return { ok: false, reason: "Account read is incomplete." };
	}
	if (
		observed.apiKeyId === null ||
		observed.memberId === null ||
		observed.subaccount === null
	) {
		return { ok: false, reason: "Observed account identity is unknown." };
	}
	if (observed.apiKeyId !== binding.apiKeyId) {
		return { ok: false, reason: "API key id does not match the a1 binding." };
	}
	if (observed.memberId !== binding.memberId) {
		return { ok: false, reason: "Member id does not match the a1 binding." };
	}
	if (observed.subaccount !== binding.subaccount) {
		return { ok: false, reason: "Subaccount does not match the a1 binding." };
	}
	if (
		binding.distinctFromMemberId !== null &&
		observed.memberId === binding.distinctFromMemberId
	) {
		return {
			ok: false,
			reason: "Observed member matches the rejected account. No fallback.",
		};
	}
	return { ok: true };
}

function checkFreshness(
	state: OlgaState,
	nowMs: number,
	feedAtMs: number | null,
): { ok: true } | { ok: false; reason: string; freeze: boolean } {
	if (state.clock.frozen) {
		return {
			ok: false,
			reason: "Clock or feed halt is frozen. No catch-up.",
			freeze: false,
		};
	}
	if (!Number.isFinite(nowMs)) {
		return { ok: false, reason: "Clock is unknown.", freeze: true };
	}
	if (nowMs + MAX_CLOCK_BACK_MS < state.clock.lastClockMs) {
		return { ok: false, reason: "Clock moved backwards.", freeze: true };
	}
	if (nowMs - state.clock.lastClockMs > MAX_AWAKE_GAP_MS) {
		return {
			ok: false,
			reason: "Sleep or stale clock gap. No catch-up.",
			freeze: true,
		};
	}
	if (feedAtMs === null || !Number.isFinite(feedAtMs)) {
		return { ok: false, reason: "Market feed is missing.", freeze: true };
	}
	if (nowMs - feedAtMs > MAX_FEED_AGE_MS) {
		return { ok: false, reason: "Market feed is stale.", freeze: true };
	}
	if (feedAtMs > nowMs + MAX_CLOCK_BACK_MS) {
		return {
			ok: false,
			reason: "Feed timestamp is ahead of the clock.",
			freeze: true,
		};
	}
	return { ok: true };
}

function stop(reason: string, freezeClock = false): OlgaDecision {
	return {
		action: "STOP",
		reasons: [reason],
		submits: 0,
		retries: 0,
		freezeClock,
	};
}
