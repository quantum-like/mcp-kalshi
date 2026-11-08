export const DATA_GUARD_DEFAULTS = {
	mode: "000",
	historicalDays: [] as string[],
} as const;

export const UNCONFIGURED_DATE_POLICY = {
	authoritative: false as const,
	reason:
		"Authoritative source calendar is not configured. Every dated record is quarantined before decoding. America/Los_Angeles is not treated as the study clock. A reviewed config must name the zone and whether the date is the source date, contract open, close, resolution, or observation time.",
};

export type ClockMeaning =
	| "source"
	| "open"
	| "close"
	| "resolution"
	| "observation";

export interface AuthoritativeDatePolicy {
	authoritative: true;
	/** Operator-supplied IANA zone. Not evidence of the original study clock. */
	timeZone: string;
	sealedStart: string;
	sealedEnd: string;
	quarantineDates: string[];
	clockMeaning: ClockMeaning;
}

export type DatePolicy =
	| typeof UNCONFIGURED_DATE_POLICY
	| AuthoritativeDatePolicy;

export type GuardDecision = "allow" | "sealed" | "quarantine" | "reject";

export interface DatedRecord {
	id: string;
	start?: string;
	end?: string;
	kind?: string;
	payload?: unknown;
}

export function calendarDateInZone(
	value: string,
	timeZone: string,
): string | null {
	const instant = new Date(value);
	if (Number.isNaN(instant.getTime())) return null;
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(instant);
	const pick = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? "";
	const date = `${pick("year")}-${pick("month")}-${pick("day")}`;
	return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function classifyConfigured(
	value: string | undefined,
	policy: AuthoritativeDatePolicy,
): GuardDecision {
	if (!value) return "reject";
	const date = calendarDateInZone(value, policy.timeZone);
	if (!date) return "reject";
	if (policy.quarantineDates.includes(date)) return "quarantine";
	if (date >= policy.sealedStart && date <= policy.sealedEnd) return "sealed";
	return "allow";
}

/**
 * Unconfigured policy quarantines every record before the decoder runs.
 * An authoritative policy is only as good as the operator config; this
 * module does not know the original holdout clock.
 */
export function screenRecord(
	record: DatedRecord,
	decode: (payload: unknown) => unknown,
	policy: DatePolicy = UNCONFIGURED_DATE_POLICY,
): { decision: GuardDecision; reason?: string; decoded?: unknown } {
	if (record.kind === "mixed-summary") {
		return { decision: "reject", reason: "mixed summary" };
	}
	if (!policy.authoritative) {
		return { decision: "quarantine", reason: policy.reason };
	}
	const start = classifyConfigured(record.start, policy);
	const end =
		record.end === undefined ? start : classifyConfigured(record.end, policy);
	if (start === "reject" || end === "reject") {
		return { decision: "reject", reason: "malformed or missing timestamp" };
	}
	if (start !== end) {
		return { decision: "reject", reason: "cross-boundary record" };
	}
	if (start !== "allow") {
		return { decision: start };
	}
	return { decision: "allow", decoded: decode(record.payload) };
}
