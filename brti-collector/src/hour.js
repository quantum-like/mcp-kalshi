import { halt } from "./errors.js";

export const HOUR_MS = 3_600_000;
export const TICK_MS = 200;
export const DEFAULT_LAG_MS = 120_000;
export const HOUR_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/;

export function assertHourAligned(iso) {
	if (typeof iso !== "string" || !HOUR_ISO.test(iso)) {
		halt("hour_alignment", "Query timestamp must be an hour-aligned UTC instant.");
	}
	const start = Date.parse(iso);
	if (!Number.isFinite(start) || new Date(start).toISOString() !== iso) {
		halt("hour_alignment", "Query timestamp is not a real UTC hour.");
	}
	return start;
}

export function assertCompletedHour(iso, nowMs, lagMs = DEFAULT_LAG_MS) {
	const start = assertHourAligned(iso);
	if (!Number.isFinite(nowMs) || !Number.isFinite(lagMs) || lagMs < 0) {
		halt("clock", "Completion clock is not finite.");
	}
	if (nowMs < start + HOUR_MS + lagMs) {
		halt("hour_open", "Refusing an hour that is not completed plus the publication lag.");
	}
	return { iso, startMs: start, endMs: start + HOUR_MS };
}

export function pacificLabel(ms) {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Los_Angeles",
		timeZoneName: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).format(new Date(ms));
}
