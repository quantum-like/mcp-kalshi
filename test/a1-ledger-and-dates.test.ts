import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type AuthoritativeDatePolicy,
	DATA_GUARD_DEFAULTS,
	calendarDateInZone,
	screenRecord,
} from "../src/data-guard/sealed-window.js";
import { ENFORCEMENT_BOUNDARY } from "../src/strategy/boundary.js";
import { roundingFeeExample } from "../src/strategy/fees.js";
import {
	type BeginIntentInput,
	StrategyLedger,
	executeOnce,
} from "../src/strategy/ledger.js";
import { createA1Tools } from "../src/tools/a1.js";

const account = {
	complete: true,
	positions: [] as Array<{ ticker: string; position_fp?: string }>,
};

function intent(overrides: Partial<BeginIntentInput> = {}): BeginIntentInput {
	return {
		clientOrderId: "intent-1",
		ticker: "KXBTC15M-26NOV07-B100",
		side: "yes",
		action: "buy",
		count: "1.00",
		price: "0.400000",
		feeType: "quadratic",
		feeMultiplier: "1.000000",
		balancePrecision: "0.01",
		account,
		...overrides,
	};
}

test("fee rounding example matches the published cent alignment", () => {
	const example = roundingFeeExample();
	assert.equal(example.tradeFee, "0.003639");
	assert.equal(example.alignedChange, "-0.060000");
	assert.equal(example.roundingFee, "0.001361");
});

test("disarmed ledger refuses reservations and documents the enforcement boundary", async () => {
	const directory = await mkdtemp(join(tmpdir(), "a1-disarmed-"));
	try {
		const ledger = new StrategyLedger(directory);
		let submits = 0;
		await assert.rejects(
			executeOnce(ledger, intent(), async () => {
				submits += 1;
				return { orderId: "nope" };
			}),
			/DISARMED/,
		);
		assert.equal(submits, 0);
		const tools = createA1Tools(
			{
				async readBalance() {
					return {
						balance_dollars: "UNKNOWN dollars",
						balance_cents: "UNKNOWN cents",
						portfolio_value_cents: "UNKNOWN cents",
						updated: "UNKNOWN",
					};
				},
				async readPositions() {
					throw new Error("unused");
				},
				async readOrders() {
					throw new Error("unused");
				},
				async readFills() {
					throw new Error("unused");
				},
				async readSettlements() {
					throw new Error("unused");
				},
			} as never,
			directory,
		);
		const status = tools.find((tool) => tool.name === "A1_STRATEGY_STATUS");
		assert.ok(status);
		const text = await status.execute();
		assert.match(text, /armed: false/);
		assert.match(text, /capital: 5\.000000/);
		assert.match(text, new RegExp(ENFORCEMENT_BOUNDARY.slice(0, 40)));
		assert.match(text, /historical_mode: 000/);
		assert.match(text, /historical_days: none/);
		assert.deepEqual(DATA_GUARD_DEFAULTS.historicalDays, []);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("$5 reservations, fees, fractional fills, flips, and SENATEAK protection", async () => {
	const directory = await mkdtemp(join(tmpdir(), "a1-ledger-"));
	try {
		const ledger = new StrategyLedger(directory);
		await ledger.armForOfflineTests();
		const results = await Promise.allSettled([
			ledger.beginIntent(
				intent({ clientOrderId: "big-a", count: "10.00", price: "0.400000" }),
			),
			ledger.beginIntent(
				intent({ clientOrderId: "big-b", count: "10.00", price: "0.400000" }),
			),
		]);
		const rejected = results.filter((result) => result.status === "rejected");
		const accepted = results.find((result) => result.status === "fulfilled");
		assert.equal(rejected.length, 1);
		assert.ok(accepted && accepted.status === "fulfilled");
		const state = await ledger.status();
		assert.equal(state.cash, "5.000000");
		assert.notEqual(ledger.freeCash(state), "5.000000");
		await assert.rejects(
			ledger.beginIntent(
				intent({ clientOrderId: "senate", ticker: "SENATEAK-2026" }),
			),
			/protected/,
		);
		await assert.rejects(
			ledger.beginIntent(
				intent({
					clientOrderId: "mixed",
					account: {
						complete: true,
						positions: [{ ticker: "KXBTC15M-OLD", position_fp: "129.39" }],
					},
				}),
			),
			/mixed ownership/,
		);
		await assert.rejects(
			ledger.beginIntent(
				intent({
					clientOrderId: "partial-read",
					account: { complete: false, positions: [] },
				}),
			),
			/incomplete/,
		);
		const open = accepted.value.intent;
		await ledger.applyFill({
			fillId: "fill-frac",
			clientOrderId: open.clientOrderId,
			ticker: open.ticker,
			outcomeSide: "yes",
			count: "0.50",
			price: "0.400000",
			fee: "0.020000",
			action: "buy",
		});
		const after = await ledger.status();
		assert.equal(after.cash, "4.780000");
		await ledger.applyFill({
			fillId: "fill-frac",
			clientOrderId: open.clientOrderId,
			ticker: open.ticker,
			outcomeSide: "yes",
			count: "0.50",
			price: "4.000000",
			fee: "0.020000",
			action: "buy",
		});
		assert.equal((await ledger.status()).cash, "4.780000");
		await ledger.applySettlement({
			key: "settle-1",
			ticker: open.ticker,
			revenueCents: 100,
		});
		await ledger.applySettlement({
			key: "settle-1",
			ticker: open.ticker,
			revenueCents: 100,
		});
		assert.equal((await ledger.status()).cash, "5.780000");
		await assert.rejects(
			ledger.applySettlement({ key: "bad", ticker: "SENATEAK-2026" }),
			/protected/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("timeout freezes the intent, does not retry, and survives a restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "a1-crash-"));
	try {
		const ledger = new StrategyLedger(directory);
		await ledger.armForOfflineTests();
		let submits = 0;
		await assert.rejects(
			executeOnce(ledger, intent({ clientOrderId: "once" }), async () => {
				submits += 1;
				throw new Error("timeout");
			}),
			/timeout/,
		);
		assert.equal(submits, 1);
		const restarted = new StrategyLedger(directory);
		const again = await executeOnce(
			restarted,
			intent({ clientOrderId: "once" }),
			async () => {
				submits += 1;
				return { orderId: "should-not-send" };
			},
		);
		assert.equal(again.submitted, false);
		assert.equal(submits, 1);
		assert.equal(again.intent.state, "unknown");
		await assert.rejects(
			restarted.releaseIfAbsent(again.intent.id, false),
			/Incomplete read/,
		);
		await restarted.releaseIfAbsent(again.intent.id, true);
		const freed = await restarted.status();
		assert.equal(freed.intents[0]?.state, "released");
		assert.equal(restarted.freeCash(freed), "5.000000");
		const ack = await executeOnce(
			restarted,
			intent({ clientOrderId: "ioc" }),
			async () => ({
				orderId: "ord-ioc",
				fillCount: "0.50",
				remainingCount: "0.00",
			}),
		);
		assert.equal(ack.submitted, true);
		assert.equal(ack.intent.ackFillCount, "0.50");
		assert.notEqual(ack.intent.reservedNotional, "0.000000");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

const fixturePolicy: AuthoritativeDatePolicy = {
	authoritative: true,
	timeZone: "UTC",
	sealedStart: "2026-08-01",
	sealedEnd: "2026-10-07",
	quarantineDates: ["2026-10-08"],
	clockMeaning: "observation",
};

test("unconfigured dates are quarantined and do not claim a study timezone", () => {
	let decoded = 0;
	const decode = () => {
		decoded += 1;
		return { secret: "value" };
	};
	for (const start of [
		"2026-08-01T00:30:00.000Z",
		"2026-10-07T23:30:00.000Z",
		"2026-10-08T00:30:00.000Z",
		"2026-10-09T12:00:00.000Z",
		"2026-11-01T08:30:00.000Z",
		"2026-03-08T09:30:00.000Z",
	]) {
		const result = screenRecord(
			{ id: start, start, payload: { n: 1 } },
			decode,
		);
		assert.equal(result.decision, "quarantine");
		assert.match(result.reason ?? "", /Authoritative source calendar/);
	}
	assert.equal(
		screenRecord(
			{
				id: "mixed",
				kind: "mixed-summary",
				start: "2026-10-09T00:00:00.000Z",
			},
			decode,
		).decision,
		"reject",
	);
	assert.equal(decoded, 0);
	const boundary = "2026-10-08T06:30:00.000Z";
	assert.equal(calendarDateInZone(boundary, "UTC"), "2026-10-08");
	assert.equal(
		calendarDateInZone(boundary, "America/Los_Angeles"),
		"2026-10-07",
	);
	assert.equal(DATA_GUARD_DEFAULTS.mode, "000");
	assert.deepEqual([...DATA_GUARD_DEFAULTS.historicalDays], []);
});

test("an explicit fixture policy can seal a window without being the source clock", () => {
	let decoded = 0;
	const decode = () => {
		decoded += 1;
		return { ok: true };
	};
	assert.equal(
		screenRecord(
			{ id: "a", start: "2026-08-01T00:30:00.000Z" },
			decode,
			fixturePolicy,
		).decision,
		"sealed",
	);
	assert.equal(
		screenRecord(
			{ id: "b", start: "2026-10-07T23:00:00.000Z" },
			decode,
			fixturePolicy,
		).decision,
		"sealed",
	);
	assert.equal(
		screenRecord(
			{ id: "c", start: "2026-10-08T00:30:00.000Z" },
			decode,
			fixturePolicy,
		).decision,
		"quarantine",
	);
	assert.equal(
		screenRecord({ id: "d", start: "not-a-date" }, decode, fixturePolicy)
			.decision,
		"reject",
	);
	assert.equal(
		screenRecord(
			{
				id: "e",
				start: "2026-10-07T12:00:00.000Z",
				end: "2026-10-09T12:00:00.000Z",
			},
			decode,
			fixturePolicy,
		).decision,
		"reject",
	);
	assert.equal(
		screenRecord(
			{ id: "f", start: "2026-10-09T12:00:00.000Z", payload: { n: 1 } },
			decode,
			fixturePolicy,
		).decision,
		"allow",
	);
	assert.equal(decoded, 1);
});
