import { decimalToE8 } from "./certify.js";
import { halt } from "./errors.js";

export const COINBASE_ORIGIN = "https://api.exchange.coinbase.com";
export const PROVISIONAL_DISCREPANCY_BP = 50;
export const PROVISIONAL_SUSTAINED_SECONDS = 30;
export const PROVISIONAL_MIN_COVERAGE = 0.95;
export const MAX_OBSERVATION_AGE_MS = 2_000;

export function coinbasePublicRequest(url) {
	const parsed = new URL(url);
	if (parsed.origin !== COINBASE_ORIGIN || parsed.protocol !== "https:") {
		halt("coinbase_origin", "Coinbase comparison origin is not the public allowlist.");
	}
	if (parsed.searchParams.has("KALSHI-ACCESS-KEY")) {
		halt("coinbase_auth", "Coinbase requests cannot carry Kalshi credentials.");
	}
	return { method: "GET", url: parsed.toString(), headers: {} };
}

export function assertNoKalshiHeaders(headers) {
	for (const name of Object.keys(headers ?? {})) {
		if (name.toUpperCase().startsWith("KALSHI-")) {
			halt("coinbase_auth", "Refusing to send Kalshi headers to Coinbase.");
		}
	}
}

export function compareCoinbase({ samples, rows, startMs, endMs, sourceKind }) {
	const kind = sourceKind ?? "unspecified";
	const limitation =
		kind === "mid"
			? "Quote mid samples."
			: "Not a quote mid. Candles or trades cannot certify the settlement index.";
	if (!Array.isArray(samples) || samples.length === 0) {
		return {
			available: false,
			threshold_is_certification: false,
			source_kind: kind,
			limitation,
			label: "Coinbase comparison unavailable. Hour is not certified.",
		};
	}
	const brti = rows
		.filter((row) => row.time >= startMs && row.time < endMs)
		.sort((a, b) => a.time - b.time);
	let matched = 0;
	let run = 0;
	let longest = 0;
	const discrepancies = [];
	for (let second = startMs; second < endMs; second += 1000) {
		const brtiRow = [...brti].reverse().find((row) => row.time >= second && row.time < second + 1000);
		const sample = [...samples]
			.reverse()
			.find((item) => item.timeMs <= second && second - item.timeMs <= MAX_OBSERVATION_AGE_MS);
		if (!brtiRow || !sample) {
			run = 0;
			continue;
		}
		const left = brtiRow.price ?? decimalToE8(brtiRow.value);
		const right = sample.midE8 ?? decimalToE8(String(sample.price));
		if (left === null || right === null) {
			run = 0;
			continue;
		}
		matched += 1;
		const delta = right > left ? right - left : left - right;
		const bp = Number((delta * 10_000n) / left);
		discrepancies.push(bp);
		if (bp > PROVISIONAL_DISCREPANCY_BP) {
			run += 1;
			longest = Math.max(longest, run);
		} else {
			run = 0;
		}
	}
	const seconds = (endMs - startMs) / 1000;
	discrepancies.sort((a, b) => a - b);
	const coverage = matched / seconds;
	return {
		available: true,
		threshold_is_certification: false,
		source_kind: kind,
		limitation,
		matched_seconds: matched,
		coverage,
		coverage_meets_provisional_95: coverage >= PROVISIONAL_MIN_COVERAGE,
		sustained_seconds_over_50bp: longest,
		provisional_alert: coverage < PROVISIONAL_MIN_COVERAGE || longest >= PROVISIONAL_SUSTAINED_SECONDS,
		median_bp: discrepancies.length ? discrepancies[Math.floor(discrepancies.length / 2)] : null,
		p95_bp: discrepancies.length ? discrepancies[Math.floor(discrepancies.length * 0.95)] : null,
		max_bp: discrepancies.length ? discrepancies.at(-1) : null,
		label: "Provisional comparison only. It is not a certification threshold.",
	};
}
