import { formatPacific } from "../lib/pst.js";

/** Los Angeles calendar dates. Synthetic fixtures only. */
export const SEALED_START = "2026-08-01";
export const SEALED_END = "2026-10-07";
export const VENDOR_QUARANTINE = "2026-10-08";

export const DATA_GUARD_DEFAULTS = {
	mode: "000",
	historicalDays: [] as string[],
} as const;

export type GuardDecision = "allow" | "sealed" | "quarantine" | "reject";

export interface DatedRecord {
	id: string;
	start?: string;
	end?: string;
	payload?: unknown;
}

export function classifyInstant(value: string | undefined): GuardDecision {
	if (!value) return "reject";
	const stamp = formatPacific(value);
	if (!stamp.calendarDate) return "reject";
	return classifyDate(stamp.calendarDate);
}

export function classifyDate(calendarDate: string): GuardDecision {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(calendarDate)) return "reject";
	if (calendarDate === VENDOR_QUARANTINE) return "quarantine";
	if (calendarDate >= SEALED_START && calendarDate <= SEALED_END) {
		return "sealed";
	}
	return "allow";
}

/**
 * Reject sealed, quarantined, unknown, and cross-boundary records
 * before the payload decoder runs.
 */
export function screenRecord(
	record: DatedRecord,
	decode: (payload: unknown) => unknown,
): { decision: GuardDecision; decoded?: unknown } {
	const start = classifyInstant(record.start);
	const end = record.end === undefined ? start : classifyInstant(record.end);
	if (start === "reject" || end === "reject") {
		return { decision: "reject" };
	}
	if (start !== end) {
		return { decision: "reject" };
	}
	if (start !== "allow") {
		return { decision: start };
	}
	return { decision: "allow", decoded: decode(record.payload) };
}
