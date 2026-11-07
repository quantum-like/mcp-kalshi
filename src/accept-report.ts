export interface ReportCounts {
	tests: number | null;
	pass: number | null;
	fail: number | null;
	cancelled: number | null;
	skipped: number | null;
	todo: number | null;
	conflicts: string[];
}

export interface AcceptanceDecision {
	ok: boolean;
	discovered: number;
	expected: number;
	reason?: string;
}

const FIELD = String.raw`tests|pass|fail|cancelled|skipped|todo`;

/** Last TAP (`# tests N`) or spec (`ℹ tests N`) summary field. */
export function parseTestReport(output: string): ReportCounts {
	const ansiEscape = String.fromCharCode(27);
	const clean = output
		.split(ansiEscape)
		.map((part, index) =>
			index === 0 ? part : part.replace(/^\[[0-9;]*m/, ""),
		)
		.join("");
	const counts: ReportCounts = {
		tests: null,
		pass: null,
		fail: null,
		cancelled: null,
		skipped: null,
		todo: null,
		conflicts: [],
	};
	const seen = new Map<keyof ReportCounts, Set<number>>();
	const pattern = new RegExp(
		String.raw`(^|\n)[ \t]*(?:#[ \t]+|\u2139[ \t]+|info[ \t]+)(${FIELD})[ \t]+(\d+)\b`,
		"gi",
	);
	for (const match of clean.matchAll(pattern)) {
		const key = match[2].toLowerCase() as keyof ReportCounts;
		if (key === "conflicts") continue;
		const value = Number(match[3]);
		const values = seen.get(key) ?? new Set<number>();
		values.add(value);
		seen.set(key, values);
		counts[key] = value;
	}
	for (const [key, values] of seen) {
		if (values.size > 1) counts.conflicts.push(key);
	}
	return counts;
}

export function evaluateAcceptance(input: {
	output: string;
	status: number | null;
	fileCount: number;
	expected: number;
}): AcceptanceDecision {
	if (!Number.isInteger(input.expected) || input.expected < 1) {
		return {
			ok: false,
			discovered: 0,
			expected: input.expected,
			reason: "EXPECTED_TESTS is missing or zero.",
		};
	}
	if (input.fileCount < 1) {
		return {
			ok: false,
			discovered: 0,
			expected: input.expected,
			reason: "zero test files discovered.",
		};
	}
	const counts = parseTestReport(input.output);
	if (counts.conflicts.length > 0) {
		return {
			ok: false,
			discovered: counts.tests ?? 0,
			expected: input.expected,
			reason: `reporter counts disagree: ${counts.conflicts.join(", ")}.`,
		};
	}
	const discovered = counts.tests ?? 0;
	if (discovered === 0) {
		return {
			ok: false,
			discovered: 0,
			expected: input.expected,
			reason: "zero tests discovered.",
		};
	}
	if (discovered !== input.expected) {
		return {
			ok: false,
			discovered,
			expected: input.expected,
			reason: `expected ${input.expected} tests, discovered ${discovered}.`,
		};
	}
	const parts = [
		counts.pass,
		counts.fail,
		counts.cancelled,
		counts.skipped,
		counts.todo,
	];
	if (parts.some((value) => value === null)) {
		return {
			ok: false,
			discovered,
			expected: input.expected,
			reason: "test summary is missing pass or fail counts.",
		};
	}
	const sum =
		(counts.pass ?? 0) +
		(counts.fail ?? 0) +
		(counts.cancelled ?? 0) +
		(counts.skipped ?? 0) +
		(counts.todo ?? 0);
	if (sum !== discovered) {
		return {
			ok: false,
			discovered,
			expected: input.expected,
			reason:
				"pass, fail, cancelled, skipped, and todo do not add up to tests.",
		};
	}
	if ((counts.fail ?? 0) > 0 || (input.status ?? 1) !== 0) {
		return {
			ok: false,
			discovered,
			expected: input.expected,
			reason: `test command failed (status ${input.status ?? "null"}, fail ${counts.fail}).`,
		};
	}
	return { ok: true, discovered, expected: input.expected };
}
