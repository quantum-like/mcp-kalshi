import assert from "node:assert/strict";
import { test } from "node:test";
import { exportRecertification, recertify } from "../src/recertify.js";
import { assessOperatorSummaries } from "../src/pipeline.js";
import { HOUR, HOUR_START, cleanRows } from "./helpers.js";

const CLOSED = HOUR_START + 3_600_000;

function completeFixture(patch = {}) {
	return {
		synthetic: true,
		hourIso: HOUR,
		closedAtMs: CLOSED,
		brti: cleanRows(),
		quotes: [
			{ timeMs: HOUR_START, bid: "100.00", ask: "100.02" },
			{ timeMs: HOUR_START + 1000, bid: "100.01", ask: "100.03" },
		],
		trades: [
			{ tradeId: "t-1", manifestId: "m-1", timeMs: HOUR_START + 10 },
			{ tradeId: "t-2", manifestId: "m-1", timeMs: HOUR_START + 20 },
		],
		manifests: [{ manifestId: "m-1", tradeIds: ["t-1", "t-2"] }],
		revisions: [{ tradeId: "t-1", revisedAtMs: CLOSED - 1 }],
		outcome: { result: "yes", joinedAtMs: CLOSED - 1 },
		...patch,
	};
}

test("synthetic complete window passes data gates and stays uncertified", () => {
	const report = exportRecertification(completeFixture());
	assert.equal(report.schema, "brti-recertify-export-1");
	assert.equal(report.synthetic, true);
	assert.equal(report.realObservation, false);
	assert.equal(report.dataGates, "pass");
	assert.equal(report.rawClean, true);
	assert.equal(report.uniqueBrtiRows, 18000);
	assert.equal(report.missingBid, 0);
	assert.equal(report.missingAsk, 0);
	assert.equal(report.certification, "NOT_CERTIFIED");
	assert.equal(report.certifiedFile, null);
});

test("missing bid or ask fails closed", () => {
	const report = recertify(completeFixture({
		quotes: [{ timeMs: HOUR_START, bid: "100.00", ask: null }, { timeMs: HOUR_START, bid: null, ask: "100.00" }],
	}));
	assert.equal(report.dataGates, "fail");
	assert.equal(report.missingBid, 1);
	assert.equal(report.missingAsk, 1);
	assert.equal(report.certification, "NOT_CERTIFIED");
});

test("incomplete trade tape fails closed", () => {
	const report = recertify(completeFixture({
		manifests: [{ manifestId: "m-1", tradeIds: ["t-1", "t-2", "t-missing"] }],
	}));
	assert.equal(report.dataGates, "fail");
	assert.equal(report.reasons.includes("manifest trade is missing from the tape"), true);
	assert.equal(report.certification, "NOT_CERTIFIED");
});

test("late revision fails closed", () => {
	const report = recertify(completeFixture({
		revisions: [{ tradeId: "t-1", revisedAtMs: CLOSED + 1 }],
	}));
	assert.equal(report.dataGates, "fail");
	assert.equal(report.reasons.includes("late revision after close"), true);
});

test("late outcome fails closed", () => {
	const report = recertify(completeFixture({
		outcome: { result: "no", joinedAtMs: CLOSED + 5 },
	}));
	assert.equal(report.dataGates, "fail");
	assert.equal(report.reasons.includes("late outcome after close"), true);
	const missing = recertify(completeFixture({ outcome: null }));
	assert.equal(missing.reasons.includes("outcome join is missing"), true);
});

test("operator Nov 7 summary is not recertified as a tape", () => {
	const summary = assessOperatorSummaries({
		trades: {
			rawTapePresent: false,
			uniqueTrades: 524455,
			manifests: 2142,
			closedWindows: 12,
			firstWindowStartupGaps: true,
			laterWindows: 11,
			laterWindowMaxInternalGapSec: 4,
		},
		quotes: {
			rawTapePresent: false,
			snapshotsMissingBidOrAsk: 303,
			windows: 13,
			postStartupClosedWindows: 11,
		},
	});
	assert.equal(summary.certification, "NOT_CERTIFIED");
	assert.equal(summary.certifiedWindows, 0);
	assert.throws(() => recertify({ kind: "operator_summary", rawTapePresent: false }), /operator summary/);
	assert.throws(() => recertify({ hourIso: HOUR }), /Missing recertifier input/);
});
