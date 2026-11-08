import { halt } from "./errors.js";
import { assertHourAligned } from "./hour.js";
import { assessRawHour } from "./pipeline.js";
import { decimalToE8 } from "./certify.js";

export const RECERTIFY_SCHEMA = "brti-recertify-input-1";
export const EXPORT_SCHEMA = "brti-recertify-export-1";

const REQUIRED = ["hourIso", "closedAtMs", "brti", "quotes", "trades", "manifests", "revisions", "outcome"];

function requireInput(input) {
	if (input?.kind === "operator_summary" || input?.rawTapePresent === false) {
		halt("schema", "An operator summary is not a raw tape. Refusing to recertify it.");
	}
	for (const key of REQUIRED) {
		if (!(key in (input ?? {}))) halt("schema", `Missing recertifier input ${key}.`);
	}
	if (!Number.isFinite(input.closedAtMs)) halt("schema", "closedAtMs must be a finite Unix millisecond.");
	if (!Array.isArray(input.brti) || !Array.isArray(input.quotes) || !Array.isArray(input.trades)) {
		halt("schema", "brti, quotes, and trades must be arrays.");
	}
	if (!Array.isArray(input.manifests) || !Array.isArray(input.revisions)) {
		halt("schema", "manifests and revisions must be arrays.");
	}
	return input;
}

function quoteReasons(quotes) {
	const reasons = [];
	let missingBid = 0;
	let missingAsk = 0;
	quotes.forEach((quote, index) => {
		if (decimalToE8(quote?.bid) === null) {
			missingBid += 1;
			reasons.push(`quote ${index} is missing a bid`);
		}
		if (decimalToE8(quote?.ask) === null) {
			missingAsk += 1;
			reasons.push(`quote ${index} is missing an ask`);
		}
	});
	return { reasons, missingBid, missingAsk };
}

function tradeReasons(trades, manifests) {
	const reasons = [];
	const seen = new Set();
	const byManifest = new Map();
	for (const trade of trades) {
		if (typeof trade?.tradeId !== "string" || trade.tradeId.length === 0) {
			reasons.push("trade id is missing");
			continue;
		}
		if (seen.has(trade.tradeId)) reasons.push("duplicate trade id");
		seen.add(trade.tradeId);
		if (typeof trade.manifestId !== "string" || trade.manifestId.length === 0) {
			reasons.push("trade manifest id is missing");
			continue;
		}
		const bucket = byManifest.get(trade.manifestId) ?? [];
		bucket.push(trade.tradeId);
		byManifest.set(trade.manifestId, bucket);
	}
	const manifestIds = new Set();
	for (const manifest of manifests) {
		if (typeof manifest?.manifestId !== "string") {
			reasons.push("manifest id is missing");
			continue;
		}
		if (manifestIds.has(manifest.manifestId)) reasons.push("duplicate manifest id");
		manifestIds.add(manifest.manifestId);
		if (!Array.isArray(manifest.tradeIds)) {
			reasons.push("manifest trade list is missing");
			continue;
		}
		for (const tradeId of manifest.tradeIds) {
			if (!seen.has(tradeId)) reasons.push("manifest trade is missing from the tape");
		}
		for (const tradeId of byManifest.get(manifest.manifestId) ?? []) {
			if (!manifest.tradeIds.includes(tradeId)) reasons.push("trade is missing from its manifest");
		}
	}
	for (const manifestId of byManifest.keys()) {
		if (!manifestIds.has(manifestId)) reasons.push("trade manifest is missing");
	}
	return reasons;
}

function revisionReasons(revisions, closedAtMs) {
	const reasons = [];
	for (const revision of revisions) {
		if (!Number.isFinite(revision?.revisedAtMs)) {
			reasons.push("revision time is missing");
			continue;
		}
		if (revision.revisedAtMs > closedAtMs) reasons.push("late revision after close");
	}
	return reasons;
}

function outcomeReasons(outcome, closedAtMs) {
	if (outcome === null) return ["outcome join is missing"];
	if (outcome?.result !== "yes" && outcome?.result !== "no") return ["outcome join is missing"];
	if (!Number.isFinite(outcome.joinedAtMs)) return ["outcome join time is missing"];
	if (outcome.joinedAtMs > closedAtMs) return ["late outcome after close"];
	return [];
}

export function recertify(input) {
	const record = requireInput(input);
	const startMs = assertHourAligned(record.hourIso);
	const raw = assessRawHour(record.brti, startMs);
	const quotes = quoteReasons(record.quotes);
	const reasons = [
		...(raw.rawClean ? [] : ["raw BRTI is not aligned to the completed-hour 200 ms grid", ...raw.reasons]),
		...quotes.reasons,
		...tradeReasons(record.trades, record.manifests),
		...revisionReasons(record.revisions, record.closedAtMs),
		...outcomeReasons(record.outcome, record.closedAtMs),
	];
	return {
		schema: RECERTIFY_SCHEMA,
		hourIso: record.hourIso,
		synthetic: record.synthetic === true,
		realObservation: false,
		rawClean: raw.rawClean,
		uniqueBrtiRows: raw.uniqueRows,
		missingBid: quotes.missingBid,
		missingAsk: quotes.missingAsk,
		dataGates: reasons.length === 0 ? "pass" : "fail",
		certification: "NOT_CERTIFIED",
		certifiedFile: null,
		reasons: reasons.length === 0
			? ["data gates passed on this fixture; provisional thresholds are not a certificate and no certificate file is written"]
			: reasons,
	};
}

export function exportRecertification(input) {
	const report = recertify(input);
	return {
		schema: EXPORT_SCHEMA,
		hourIso: report.hourIso,
		synthetic: report.synthetic,
		realObservation: false,
		dataGates: report.dataGates,
		certification: "NOT_CERTIFIED",
		certifiedFile: null,
		rawClean: report.rawClean,
		uniqueBrtiRows: report.uniqueBrtiRows,
		missingBid: report.missingBid,
		missingAsk: report.missingAsk,
		reasons: report.reasons,
	};
}
