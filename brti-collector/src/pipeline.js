import { certifyRows, parseHistory } from "./certify.js";
import { HOUR_MS } from "./hour.js";

export const PIPELINE_VERSION = "0.1.2-offline";

export function assessHistoryResponse({ status, payload, hourCompleted }) {
	if (status === 200 && Array.isArray(payload) && payload.length === 0 && hourCompleted !== true) {
		return {
			liveFeed: false,
			completedHour: false,
			certification: "NOT_CERTIFIED",
			reason:
				"HTTP 200 with an empty payload is the current hour on the history route. It is not a live feed and not a completed hour.",
		};
	}
	return null;
}

export function assessRawHour(rows, startMs) {
	const report = certifyRows(rows, startMs, null);
	return {
		rawClean: report.rawClean,
		reasons: report.reasons,
		uniqueRows: report.uniqueRows,
		certification: "NOT_CERTIFIED",
		liveFeed: false,
		hourMs: HOUR_MS,
	};
}

export function assessWindow(window) {
	const reasons = [];
	if (window.brtiRawClean !== true) reasons.push("raw BRTI is not aligned to the completed-hour 200 ms grid");
	if (window.startupGap === true) reasons.push("startup gap");
	if (!(Number.isFinite(window.maxInternalGapMs) && window.maxInternalGapMs === 0)) {
		reasons.push("trade tape internal gap is not zero");
	}
	if ((window.missingBid ?? 0) > 0 || (window.missingAsk ?? 0) > 0 || (window.missingBidOrAsk ?? 0) > 0) {
		reasons.push("snapshots are missing bid or ask");
	}
	if (window.tradesComplete !== true) reasons.push("trade completeness is not proven");
	if (window.lateRevision === true) reasons.push("late revision after close");
	if (window.outcomeJoined !== true) reasons.push("outcome join is missing");
	if (window.quoteTimingCandidate === true) reasons.push("quote-timing candidate is not a certificate");
	return { certification: "NOT_CERTIFIED", certified: false, reasons };
}

export function assessOperatorSummaries(input) {
	const trades = input?.trades;
	const quotes = input?.quotes;
	const evidence = [];
	if (trades?.rawTapePresent !== false || quotes?.rawTapePresent !== false) {
		return {
			certification: "NOT_CERTIFIED",
			certifiedWindows: 0,
			reasons: ["refusing a summary that claims the raw tape is present in this workspace"],
		};
	}
	if (trades) {
		evidence.push({
			uniqueTrades: trades.uniqueTrades,
			manifests: trades.manifests,
			closedWindows: trades.closedWindows,
			firstWindowStartupGaps: trades.firstWindowStartupGaps === true,
			laterWindows: trades.laterWindows,
			laterWindowMaxInternalGapSec: trades.laterWindowMaxInternalGapSec,
		});
	}
	if (quotes) {
		evidence.push({
			snapshotsMissingBidOrAsk: quotes.snapshotsMissingBidOrAsk,
			windows: quotes.windows,
			postStartupClosedWindows: quotes.postStartupClosedWindows,
			role: "quote_timing_candidate",
		});
	}
	return {
		certification: "NOT_CERTIFIED",
		certifiedWindows: 0,
		liveFeed: false,
		evidence,
		reasons: [
			"raw BRTI hours for these windows are not in this workspace",
			"startup gaps and a 4 second internal gap fail the trade-tape gate",
			"303 snapshots are missing bid or ask",
			"eleven post-startup windows are quote-timing candidates only",
			"trade completeness, late revisions, and the outcome join are not proven",
			"a quote-timing candidate is not a certificate",
		],
	};
}

export function parseCompletedHourBody(body, startMs) {
	const parsed = parseHistory(JSON.parse(body.toString("utf8")));
	return assessRawHour(parsed.rows, startMs);
}
