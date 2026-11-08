import crypto from "node:crypto";
import { HOUR_MS, TICK_MS, pacificLabel } from "./hour.js";
import { halt } from "./errors.js";

export const EXPECTED_ROWS = 18_000;
export const MAX_ROWS = 25_000;
export const PROVISIONAL_RETURN_BP = 100;
export const SPEC_VERSION = "brti-collector-0.1.1";

export function decimalToE8(value) {
	if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) return null;
	const [whole, frac = ""] = value.split(".");
	if (whole === "0" && /^0*$/.test(frac)) return null;
	return BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, "0"));
}

function depthOf(value, depth) {
	if (depth > 20) halt("schema", "JSON depth exceeds the collector bound.");
	if (Array.isArray(value)) {
		for (const item of value) depthOf(item, depth + 1);
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const item of Object.values(value)) depthOf(item, depth + 1);
	}
}

export function parseHistory(parsed) {
	depthOf(parsed, 0);
	if (typeof parsed?.data?.serverTime !== "string" || !Array.isArray(parsed.data.payload)) {
		halt("schema", "History envelope is not data.serverTime plus data.payload.");
	}
	if (parsed.data.payload.length > MAX_ROWS) halt("schema", "Payload exceeds 25000 rows.");
	const rows = parsed.data.payload.map((row) => {
		if (!row || typeof row !== "object") halt("schema", "History row is unreadable.");
		if (typeof row.time !== "number" || !Number.isSafeInteger(row.time) || row.time < 1_000_000_000_000) {
			halt("schema", "History time must be integer Unix milliseconds.");
		}
		const price = decimalToE8(row.value);
		if (price === null) halt("schema", "History price must be a positive finite decimal string.");
		return { time: row.time, value: row.value, price };
	});
	return { serverTime: parsed.data.serverTime, rows };
}

export function certifyRows(rows, startMs, coinbase) {
	const endMs = startMs + HOUR_MS;
	const outside = rows.filter((row) => row.time < startMs || row.time >= endMs).length;
	const reasons = [];
	if (outside > 0) reasons.push("row outside the requested hour");
	const byTime = new Map();
	let duplicateExact = 0;
	let conflicts = 0;
	let nonmonotonic = false;
	let previous = null;
	for (const row of rows) {
		if (previous !== null && row.time <= previous) nonmonotonic = true;
		previous = row.time;
		const seen = byTime.get(row.time);
		if (!seen) {
			byTime.set(row.time, row.value);
			continue;
		}
		if (seen === row.value) duplicateExact += 1;
		else conflicts += 1;
	}
	if (nonmonotonic) reasons.push("raw timestamps are not strictly increasing");
	if (duplicateExact > 0) reasons.push("exact duplicate rows fail the raw clean-hour certificate");
	if (conflicts > 0) reasons.push("same timestamp has conflicting prices");
	const unique = [...byTime.entries()].sort((a, b) => a[0] - b[0]);
	const missing = [];
	let gapTicks = 0;
	if (unique.length > 0) {
		if (unique[0][0] !== startMs) reasons.push("first timestamp is not the hour start");
		if (unique.at(-1)[0] !== endMs - TICK_MS) reasons.push("last timestamp is not end minus 200 ms");
		for (let index = 1; index < unique.length; index += 1) {
			const delta = unique[index][0] - unique[index - 1][0];
			if (delta !== TICK_MS) {
				gapTicks += delta / TICK_MS - 1;
				missing.push(delta);
			}
		}
	} else {
		reasons.push("hour has no rows");
	}
	if (unique.length !== EXPECTED_ROWS) reasons.push("unique row count is not 18000");
	const jumps = [];
	for (let index = 1; index < unique.length; index += 1) {
		const left = decimalToE8(unique[index - 1][1]);
		const right = decimalToE8(unique[index][1]);
		if (left && right && abs(right - left) * 10_000n > left * BigInt(PROVISIONAL_RETURN_BP)) {
			jumps.push({ from: unique[index - 1][0], to: unique[index][0] });
		}
	}
	const deduped = unique.map(([time, value]) => ({ time, value }));
	const rawClean = reasons.length === 0;
	const comparison = coinbase ?? {
		available: false,
		threshold_is_certification: false,
		label: "Coinbase comparison was not supplied.",
	};
	return {
		rawClean,
		certification: "NOT_CERTIFIED",
		certification_reason:
			"Provisional Coinbase and return thresholds are not a certification threshold.",
		reasons,
		duplicateExact,
		conflicts,
		outside,
		gapCount: missing.length,
		missingEdge: unique.length === 0 || unique[0][0] !== startMs || unique.at(-1)?.[0] !== endMs - TICK_MS,
		uniqueRows: unique.length,
		first: unique[0]?.[0] ?? null,
		last: unique.at(-1)?.[0] ?? null,
		provisionalReturnFlags: jumps.length,
		provisionalReturnBp: PROVISIONAL_RETURN_BP,
		threshold_is_certification: false,
		comparison,
		deduped,
		pacific: pacificLabel(startMs),
	};
}

function abs(value) {
	return value < 0n ? -value : value;
}

export function sha256(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function buildProvenance({ hour, fetchedAtMs, status, attempts, bytes, report, attestation, build }) {
	return {
		schema: SPEC_VERSION,
		collector_commit: build.commit,
		collector_bundle_sha256: build.bundleSha256,
		origin: "https://external-api.kalshi.com",
		path: "/trade-api/v2/cfbenchmarks/history/values",
		query: { id: "BRTI", timespan: "HOUR", timestamp: hour.iso },
		hour_start_unix_ms: hour.startMs,
		hour_end_unix_ms: hour.endMs,
		hour_label_pacific: report.pacific,
		http_status: status,
		attempts,
		fetched_at_unix_ms: fetchedAtMs,
		fetched_at_utc: new Date(fetchedAtMs).toISOString(),
		response_bytes: bytes.length,
		response_sha256: sha256(bytes),
		row_count: report.uniqueRows,
		first_source_timestamp_unix_ms: report.first,
		last_source_timestamp_unix_ms: report.last,
		timestamp_unit: "unix_milliseconds",
		price_unit: "usd_decimal_string",
		scope_attestation: attestation,
		certification: report.certification,
		certification_reason: report.certification_reason,
		raw_clean_hour: report.rawClean,
		raw_reasons: report.reasons,
		duplicate_exact: report.duplicateExact,
		conflicts: report.conflicts,
		provisional_return_flags: report.provisionalReturnFlags,
		provisional_return_bp: report.provisionalReturnBp,
		threshold_is_certification: false,
		cross_check: report.comparison,
	};
}
