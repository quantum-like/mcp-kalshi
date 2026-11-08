import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyStatus, createKalshiClient } from "../src/transport.js";
import { createFakeClock, MIN_GAP_MS } from "../src/limiter.js";
import { certifyRows, parseHistory } from "../src/certify.js";
import { coinbasePublicRequest, compareCoinbase, assertNoKalshiHeaders } from "../src/coinbase.js";
import { HOUR_MS, TICK_MS } from "../src/hour.js";
import { BUILD, HOUR, HOUR_START, cleanRows, envelope, generateKey, metadata } from "./helpers.js";
import { readDedicatedCredentials } from "../src/credentials.js";

const { pem } = generateKey();
const keyId = "dedicated-read-only-key";
const credentials = readDedicatedCredentials({
	KALSHI_BRTI_RO_KEY_ID: keyId,
	KALSHI_BRTI_RO_PRIVATE_KEY: pem,
});

function client(fetchImpl, clock = createFakeClock(HOUR_START + 4_000_000)) {
	const starts = [];
	return {
		clock,
		starts,
		kalshi: createKalshiClient({
			credentials,
			clock,
			limiter: (awaitImport(clock)),
			fetchImpl: async (request) => {
				starts.push(clock.now());
				assert.equal(request.method, "GET");
				assert.equal(request.redirect, "error");
				assert.equal(request.url.startsWith("https://external-api.kalshi.com/"), true);
				return fetchImpl(request, starts.length);
			},
		}),
	};
}

function awaitImport(clock) {
	return new (class {
		constructor() {
			this.next = 0;
		}
		async acquire() {
			const wait = Math.max(0, this.next - clock.now());
			if (wait) await clock.sleep(wait);
			const started = clock.now();
			this.next = started + MIN_GAP_MS;
			return started;
		}
	})();
}

test("401, 403, entitlement text, and parameter errors do not retry", async () => {
	assert.equal(classifyStatus(401, "").code, "unauthorized");
	assert.equal(classifyStatus(403, "").action, "halt");
	assert.equal(classifyStatus(400, "upstream authorization failure").code, "entitlement_denied");
	assert.equal(classifyStatus(503, "entitlement missing").action, "halt");
	assert.equal(classifyStatus(400, "Timestamp is not truncated to the expected granularity: Hours").code, "parameter_rejected");
	assert.equal(classifyStatus(400, "Missing required request param: timestamp").code, "parameter_rejected");
	assert.equal(classifyStatus(503, "upstream timeout").action, "retry");
	const cases = [
		{ status: 401, body: { detail: "unauthorized" } },
		{ status: 403, body: { detail: "forbidden" } },
		{ status: 400, body: { detail: "upstream authorization failure" } },
		{ status: 400, body: { detail: "Missing required request param: timestamp" } },
	];
	for (const item of cases) {
		let calls = 0;
		const { kalshi } = client(() => {
			calls += 1;
			return { status: item.status, body: Buffer.from(JSON.stringify(item.body)) };
		});
		await assert.rejects(kalshi.keys(), /unauthorized|entitlement_denied|parameter_rejected/);
		assert.equal(calls, 1);
	}
});

test("429 and bare 5xx back off, and a long Retry-After halts", async () => {
	const clock = createFakeClock(0);
	const seen = [];
	const { kalshi } = client((request, n) => {
		seen.push({ auth: request.headers["KALSHI-ACCESS-TIMESTAMP"], n });
		if (n < 3) return { status: 429, body: Buffer.from("{}"), retryAfterMs: n === 1 ? 45_000 : 0 };
		return { status: 200, body: Buffer.from(JSON.stringify(metadata(keyId))) };
	}, clock);
	const ok = await kalshi.keys();
	assert.equal(ok.status, 200);
	assert.equal(seen.length, 3);
	assert.equal(seen[0].auth === seen[1].auth, false);
	const longClock = createFakeClock(0);
	const { kalshi: blocked } = client(() => ({ status: 429, body: Buffer.from("{}"), retryAfterMs: 301_000 }), longClock);
	await assert.rejects(blocked.keys(), /retry_ceiling/);
});

test("history query is hour UTC and is not part of the signed path", async () => {
	const rows = cleanRows();
	let historyUrl = "";
	const clock = createFakeClock(HOUR_START + 4_000_000);
	const { kalshi } = client((request) => {
		if (request.url.includes("/api_keys")) {
			return { status: 200, body: Buffer.from(JSON.stringify(metadata(keyId))) };
		}
		historyUrl = request.url;
		assert.equal(request.headers["KALSHI-ACCESS-TIMESTAMP"], String(clock.now()));
		const signed = request.headers["KALSHI-ACCESS-TIMESTAMP"] + "GET" + "/trade-api/v2/cfbenchmarks/history/values";
		assert.equal(signed.includes("BRTI"), false);
		return { status: 200, body: envelope(rows) };
	}, clock);
	await kalshi.keys();
	const history = await kalshi.history(HOUR);
	assert.equal(historyUrl.includes("timestamp="), true);
	assert.equal(historyUrl.includes(encodeURIComponent(HOUR)), true);
	assert.equal(historyUrl.includes("timespan=HOUR"), true);
	const report = certifyRows(parseHistory(history.parsed).rows, HOUR_START, null);
	assert.equal(report.rawClean, true);
	assert.equal(report.certification, "NOT_CERTIFIED");
	assert.equal(report.threshold_is_certification, false);
});

test("cadence failures and provisional coinbase coverage do not certify", () => {
	const start = HOUR_START;
	const rows = cleanRows();
	const missing = rows.filter((_, index) => index !== 10);
	assert.equal(certifyRows(parseHistory(JSON.parse(envelope(missing).toString())).rows, start, null).rawClean, false);
	const duplicate = rows.concat([rows[10]]);
	const duplicateReport = certifyRows(parseHistory(JSON.parse(envelope(duplicate).toString())).rows, start, null);
	assert.equal(duplicateReport.rawClean, false);
	assert.equal(duplicateReport.duplicateExact > 0, true);
	const conflict = rows.map((row, index) => (index === 4 ? { ...row, value: "1.00" } : row));
	conflict.splice(5, 0, { time: rows[4].time, value: "2.00" });
	assert.equal(certifyRows(parseHistory(JSON.parse(envelope(conflict).toString())).rows, start, null).conflicts > 0, true);
	const shuffled = rows.slice();
	[shuffled[2], shuffled[3]] = [shuffled[3], shuffled[2]];
	assert.equal(certifyRows(parseHistory(JSON.parse(envelope(shuffled).toString())).rows, start, null).rawClean, false);
	assert.throws(() => parseHistory(JSON.parse(envelope([{ time: "1794092400000", value: "1.00" }]).toString())), /milliseconds/);
	assert.throws(() => parseHistory(JSON.parse(envelope([{ time: 1794092400, value: "1.00" }]).toString())), /milliseconds/);
	assert.throws(() => parseHistory(JSON.parse(envelope([{ time: start, value: "0.00" }]).toString())), /positive/);
	const jumped = cleanRows();
	jumped[100] = { ...jumped[100], value: "90000.00" };
	const jumpReport = certifyRows(parseHistory(JSON.parse(envelope(jumped).toString())).rows, start, null);
	assert.equal(jumpReport.provisionalReturnFlags > 0, true);
	assert.equal(jumpReport.certification, "NOT_CERTIFIED");
	const comparison = compareCoinbase({
		samples: [],
		rows,
		startMs: start,
		endMs: start + HOUR_MS,
		sourceKind: "candle",
	});
	assert.equal(comparison.threshold_is_certification, false);
	assert.equal(comparison.available, false);
	const tiny = compareCoinbase({
		samples: [{ timeMs: start, price: "75000.00" }],
		rows: cleanRows().slice(0, 5),
		startMs: start,
		endMs: start + 10_000,
		sourceKind: "trade",
	});
	assert.equal(tiny.threshold_is_certification, false);
	assert.match(tiny.limitation, /Not a quote mid/);
	assert.throws(() => coinbasePublicRequest("http://example.com/btc"), /coinbase_origin/);
	assert.throws(
		() => assertNoKalshiHeaders({ "KALSHI-ACCESS-KEY": "nope" }),
		/coinbase_auth/,
	);
	const publicRequest = coinbasePublicRequest("https://api.exchange.coinbase.com/products/BTC-USD/candles");
	assert.deepEqual(publicRequest.headers, {});
	assert.equal(BUILD.commit, "test-commit");
});
