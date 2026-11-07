const PACIFIC = "America/Los_Angeles";

export interface PacificStamp {
	original: string;
	pacific: string;
	abbreviation: "PST" | "PDT" | "UNKNOWN";
	calendarDate: string | null;
}

/** Render an instant in Pacific time without discarding the original offset. */
export function formatPacific(
	original: string | number | null | undefined,
): PacificStamp {
	if (original === undefined || original === null || original === "") {
		return {
			original: "UNKNOWN",
			pacific: "UNKNOWN",
			abbreviation: "UNKNOWN",
			calendarDate: null,
		};
	}
	const source = String(original);
	const instant = new Date(source);
	if (Number.isNaN(instant.getTime())) {
		return {
			original: source,
			pacific: "UNKNOWN",
			abbreviation: "UNKNOWN",
			calendarDate: null,
		};
	}
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: PACIFIC,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short",
	}).formatToParts(instant);
	const pick = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? "";
	const zone = pick("timeZoneName");
	const abbreviation = zone === "PST" || zone === "PDT" ? zone : "UNKNOWN";
	const calendarDate = `${pick("year")}-${pick("month")}-${pick("day")}`;
	return {
		original: source,
		pacific: `${calendarDate} ${pick("hour")}:${pick("minute")}:${pick("second")} ${abbreviation}`,
		abbreviation,
		calendarDate,
	};
}
