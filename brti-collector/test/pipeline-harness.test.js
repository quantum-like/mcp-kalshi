import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { HOUR_MS, TICK_MS } from "../src/hour.js";
import { assessHistoryResponse, assessOperatorSummaries, assessRawHour, assessWindow } from "../src/pipeline.js";
import { collectOneHour } from "../src/collect.js";
import { hourDirectory, DISK_FLOOR_BYTES } from "../src/store.js";
import { createFakeClock } from "../src/limiter.js";
import { BUILD, HOUR, HOUR_START, NOW, cleanRows, envelope, generateKey, metadata, tempRoot } from "./helpers.js";

const TRADES = {
	rawTapePresent: false,
	uniqueTrades: 524455,
	manifests: 2142,
	closedWindows: 12,
	firstWindowStartupGaps: true,
	laterWindows: 11,
	laterWindowMaxInternalGapSec: 4,
};
const QUOTES = {
	rawTapePresent: false,
	snapshotsMissingBidOrAsk: 303,
	windows: 13,
	postStartupClosedWindows: 11,
};

test("empty current hour is not a live feed and gaps stay uncertified", () => {
	const empty = assessHistoryResponse({ status: 200, payload: [], hourCompleted: false });
	assert.equal(empty.liveFeed, false);
	assert.equal(empty.completedHour, false);
	assert.equal(empty.certification, "NOT_CERTIFIED");
	const summary = assessOperatorSummaries({ trades: TRADES, quotes: QUOTES });
	assert.equal(summary.certification, "NOT_CERTIFIED");
	assert.equal(summary.certifiedWindows, 0);
	assert.equal(summary.evidence[1].snapshotsMissingBidOrAsk, 303);
	const gapped = assessWindow({
		brtiRawClean: false,
		startupGap: false,
		maxInternalGapMs: 4000,
		missingBidOrAsk: 1,
		tradesComplete: false,
		lateRevision: true,
		outcomeJoined: false,
		quoteTimingCandidate: true,
	});
	assert.equal(gapped.certified, false);
	assert.equal(gapped.reasons.includes("snapshots are missing bid or ask"), true);
	assert.equal(gapped.reasons.includes("quote-timing candidate is not a certificate"), true);
	const raw = assessRawHour(
		[{ time: HOUR_START, value: "100.00" }, { time: HOUR_START + 5000, value: "100.00" }],
		HOUR_START,
	);
	assert.equal(raw.rawClean, false);
	assert.equal(raw.certification, "NOT_CERTIFIED");
	assert.equal(raw.liveFeed, false);
	const aligned = assessRawHour(cleanRows(), HOUR_START);
	assert.equal(aligned.rawClean, true);
	assert.equal(aligned.uniqueRows, 18000);
	assert.equal(aligned.certification, "NOT_CERTIFIED");
	assert.equal(HOUR_MS / TICK_MS, 18000);
});

test("a missing deduped hash is an integrity incident before HTTP and bytes stay", async () => {
	const { pem } = generateKey();
	const keyId = "dedicated-read-only-key";
	const root = await tempRoot();
	const clock = createFakeClock(NOW);
	let calls = 0;
	const run = () => collectOneHour({
		env: { KALSHI_BRTI_RO_KEY_ID: keyId, KALSHI_BRTI_RO_PRIVATE_KEY: pem },
		hourIso: HOUR,
		nowMs: NOW,
		clock,
		root,
		attestation: { kind: "synthetic-test" },
		diskFreeBytes: DISK_FLOOR_BYTES,
		build: BUILD,
		fetchImpl: async (request) => {
			calls += 1;
			if (request.url.includes("/api_keys")) {
				return { status: 200, body: Buffer.from(JSON.stringify(metadata(keyId))) };
			}
			return { status: 200, body: envelope(cleanRows()) };
		},
	});
	await run();
	const directory = hourDirectory(root, HOUR);
	const deduped = await readFile(path.join(directory, "deduped.json"));
	const response = await readFile(path.join(directory, "response.json"));
	await unlink(path.join(directory, "deduped.sha256"));
	calls = 0;
	await assert.rejects(run(), (error) => error.code === "integrity_incident");
	assert.equal(calls, 0);
	assert.deepEqual(await readFile(path.join(directory, "deduped.json")), deduped);
	assert.deepEqual(await readFile(path.join(directory, "response.json")), response);
	await assert.rejects(lstat(path.join(directory, "CERTIFIED.json")));
});

test("mac harness blocks native gates on this host and keeps the linux adapter fail-closed", async () => {
	const child = spawn(process.execPath, [fileURLToPath(new URL("../mac/mac-accept.mjs", import.meta.url))], {
		cwd: fileURLToPath(new URL("../..", import.meta.url)),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		out += chunk;
	});
	const [code] = await once(child, "exit");
	assert.equal(code, 0);
	const report = JSON.parse(out);
	assert.equal(report.suitable_for_mac_acceptance, false);
	assert.equal(report.orders_enabled, false);
	assert.equal(report.network, false);
	assert.equal(report.credentials, false);
	assert.equal(report.external_capital, "5.000000");
	assert.equal(report.o_exlock.status, "BLOCK");
	assert.equal(report.o_exlock.value_emitted, false);
	assert.equal(report.io_platform_uuid.status, "NOT_RUN");
	assert.equal(report.io_platform_uuid.value_emitted, false);
	assert.equal(report.linux_adapter.status, "PASS_LINUX_ONLY");
	assert.equal(report.linux_adapter.not_mac_acceptance, true);
	assert.equal(JSON.stringify(report).includes("/etc/machine-id"), false);
});
