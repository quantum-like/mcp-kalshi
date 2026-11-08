import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TAPERED_DECI_CENT } from "../src/orders/price-grid.js";
import { A1_MUTATION_TOOL_NAMES } from "../src/profile.js";
import { AccountReadService } from "../src/reads/account-read-service.js";
import { toolsForProfile } from "../src/server-tools.js";
import { OrdersService } from "../src/services/orders-service.js";
import { StrategyLedger } from "../src/strategy/ledger.js";
import { reconcileFromReads } from "../src/strategy/reconcile.js";
import { submitA1StrategyOrder } from "../src/strategy/submit.js";
import { createOrderTools } from "../src/tools/orders.js";

const now = new Date("2026-11-07T20:00:00.000Z");
const fresh = "2026-11-07T19:59:30.000Z";
const account = {
	complete: true,
	positions: [] as Array<{ ticker: string; position_fp?: string }>,
};

function countingApi() {
	const calls: string[] = [];
	const api = new Proxy(
		{},
		{
			get(_target, property) {
				return () => {
					calls.push(String(property));
					throw new Error(`transport ${String(property)} should not run`);
				};
			},
		},
	);
	return { api, calls };
}

test("a1 profile omits mutation tools and a2 keeps them", () => {
	const a1 = toolsForProfile("a1").map((tool) => tool.name);
	const a2 = toolsForProfile("a2").map((tool) => tool.name);
	for (const name of A1_MUTATION_TOOL_NAMES) {
		assert.equal(a1.includes(name), false, name);
		assert.equal(a2.includes(name), true, name);
	}
	assert.equal(a1.includes("READ_POSITIONS"), true);
	assert.equal(a1.includes("A1_STRATEGY_STATUS"), true);
	assert.equal(a1.includes("GET_MARKETS"), true);
});

test("adversarial a1 service and tool calls make zero transport calls", async () => {
	const { api, calls } = countingApi();
	const service = new OrdersService({
		profile: "a1",
		ordersApi: api as never,
	});
	await assert.rejects(
		service.createOrder({
			ticker: "KXBTC15M-TEST",
			side: "yes",
			action: "buy",
			count: 1,
			yesPrice: 45,
		}),
		/read-only/,
	);
	await assert.rejects(
		service.cancelOrder({ orderId: "ord", marketTicker: "KXBTC15M-TEST" }),
		/read-only/,
	);
	await assert.rejects(
		service.decreaseOrder({
			orderId: "ord",
			reduceBy: 1,
			marketTicker: "KXBTC15M-TEST",
		}),
		/read-only/,
	);
	await assert.rejects(
		service.batchCancelOrders({
			orders: [{ orderId: "ord", marketTicker: "KXBTC15M-TEST" }],
		}),
		/read-only/,
	);
	const tools = createOrderTools(service);
	const create = tools.find((tool) => tool.name === "CREATE_ORDER");
	assert.ok(create);
	const text = await create.execute({
		ticker: "KXBTC15M-TEST",
		side: "yes",
		action: "buy",
		count: 1,
		type: "limit",
		yesPrice: 45,
		priceRanges: TAPERED_DECI_CENT,
		priceObservedAt: fresh,
	});
	assert.match(text, /read-only/);
	assert.equal(calls.length, 0);
});

test("a1 submit path checks the grid and ledger before any transport", async () => {
	const directory = await mkdtemp(join(tmpdir(), "a1-submit-"));
	try {
		const ledger = new StrategyLedger(directory);
		let submits = 0;
		const submit = async () => {
			submits += 1;
			return { orderId: "ord", fillCount: "0.00", remainingCount: "1.00" };
		};
		const order = {
			ticker: "KXBTC15M-TEST",
			side: "yes" as const,
			action: "buy" as const,
			count: 1,
			yesPrice: 45,
			priceRanges: TAPERED_DECI_CENT,
			priceObservedAt: fresh,
			now,
		};
		await assert.rejects(
			submitA1StrategyOrder({
				ledger,
				order,
				feeType: "quadratic",
				feeMultiplier: "1.000000",
				balancePrecision: "0.01",
				account,
				clientOrderId: "disarmed",
				submit,
			}),
			/DISARMED/,
		);
		assert.equal(submits, 0);
		await ledger.armForOfflineTests();
		await assert.rejects(
			submitA1StrategyOrder({
				ledger,
				order: { ...order, priceRanges: undefined, clientOrderId: "nogrid" },
				feeType: "quadratic",
				feeMultiplier: "1.000000",
				balancePrecision: "0.01",
				account,
				clientOrderId: "nogrid",
				submit,
			}),
			/absent/,
		);
		await assert.rejects(
			submitA1StrategyOrder({
				ledger,
				order: {
					...order,
					yesPrice: 45,
					priceRanges: [
						{ start: "0.000000", end: "1.000000", step: "0.007000" },
					],
				},
				feeType: "quadratic",
				feeMultiplier: "1.000000",
				balancePrecision: "0.01",
				account,
				clientOrderId: "offgrid",
				submit,
			}),
			/off the current market grid/,
		);
		assert.equal(submits, 0);
		const ok = await submitA1StrategyOrder({
			ledger,
			order,
			feeType: "quadratic",
			feeMultiplier: "1.000000",
			balancePrecision: "0.01",
			account,
			clientOrderId: "on-grid",
			submit,
		});
		assert.equal(ok.submitted, true);
		assert.equal(submits, 1);
		const again = await submitA1StrategyOrder({
			ledger,
			order,
			feeType: "quadratic",
			feeMultiplier: "1.000000",
			balancePrecision: "0.01",
			account,
			clientOrderId: "on-grid",
			submit,
		});
		assert.equal(again.submitted, false);
		assert.equal(submits, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("concurrent a1 submits and a crashed unknown intent do not add transport calls", async () => {
	const directory = await mkdtemp(join(tmpdir(), "a1-race-"));
	try {
		const ledger = new StrategyLedger(directory);
		await ledger.armForOfflineTests();
		let submits = 0;
		const submit = async () => {
			submits += 1;
			return {
				orderId: `ord-${submits}`,
				fillCount: "0.00",
				remainingCount: "10.00",
			};
		};
		const big = {
			ticker: "KXBTC15M-TEST",
			side: "yes" as const,
			action: "buy" as const,
			count: 10,
			yesPrice: 40,
			priceRanges: TAPERED_DECI_CENT,
			priceObservedAt: fresh,
			now,
		};
		const results = await Promise.allSettled([
			submitA1StrategyOrder({
				ledger,
				order: big,
				feeType: "quadratic",
				feeMultiplier: "1.000000",
				balancePrecision: "0.01",
				account,
				clientOrderId: "race-a",
				submit,
			}),
			submitA1StrategyOrder({
				ledger,
				order: big,
				feeType: "quadratic",
				feeMultiplier: "1.000000",
				balancePrecision: "0.01",
				account,
				clientOrderId: "race-b",
				submit,
			}),
		]);
		assert.equal(
			results.filter((result) => result.status === "fulfilled").length,
			1,
		);
		assert.equal(submits, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a crashed a1 submit is not repeated after restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "a1-crash-"));
	try {
		const ledger = new StrategyLedger(directory);
		await ledger.armForOfflineTests();
		let crashed = 0;
		const order = {
			ticker: "KXBTC15M-TEST",
			side: "yes" as const,
			action: "buy" as const,
			count: 1,
			yesPrice: 40,
			priceRanges: TAPERED_DECI_CENT,
			priceObservedAt: fresh,
			now,
		};
		await assert.rejects(
			submitA1StrategyOrder({
				ledger,
				order,
				feeType: "quadratic",
				feeMultiplier: "1.000000",
				balancePrecision: "0.01",
				account,
				clientOrderId: "crash",
				submit: async () => {
					crashed += 1;
					throw new Error("timeout");
				},
			}),
			/timeout/,
		);
		const replay = await submitA1StrategyOrder({
			ledger: new StrategyLedger(directory),
			order,
			feeType: "quadratic",
			feeMultiplier: "1.000000",
			balancePrecision: "0.01",
			account,
			clientOrderId: "crash",
			submit: async () => {
				crashed += 1;
				return { orderId: "nope" };
			},
		});
		assert.equal(replay.submitted, false);
		assert.equal(crashed, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("reconciliation books a fractional fill once and never resubmits", async () => {
	const directory = await mkdtemp(join(tmpdir(), "a1-recon-"));
	try {
		const ledger = new StrategyLedger(directory);
		await ledger.armForOfflineTests();
		let submits = 0;
		await submitA1StrategyOrder({
			ledger,
			order: {
				ticker: "KXBTC15M-TEST",
				side: "no",
				action: "buy",
				count: 1,
				noPrice: 87,
				priceRanges: TAPERED_DECI_CENT,
				priceObservedAt: fresh,
				now,
			},
			feeType: "quadratic",
			feeMultiplier: "1.000000",
			balancePrecision: "0.01",
			account,
			clientOrderId: "recon-1",
			submit: async () => {
				submits += 1;
				throw new Error("ack lost");
			},
		}).catch(() => undefined);
		assert.equal(submits, 1);
		const incomplete = await reconcileFromReads(ledger, {
			ordersComplete: false,
			fillsComplete: false,
			orders: [],
			fills: [],
		});
		assert.equal(incomplete.resubmits, 0);
		assert.match(incomplete.notes.join(" "), /incomplete/);
		assert.equal(
			(await ledger.getByClientOrderId("recon-1"))?.state,
			"unknown",
		);
		const done = await reconcileFromReads(ledger, {
			ordersComplete: true,
			fillsComplete: true,
			orders: [
				{
					order_id: "ord-recon",
					client_order_id: "recon-1",
					status: "executed",
					fill_count_fp: "0.50",
					remaining_count_fp: "0.00",
				},
			],
			fills: [
				{
					fill_id: "fill-subcent",
					order_id: "ord-recon",
					client_order_id: "recon-1",
					ticker: "KXBTC15M-TEST",
					count_fp: "0.50",
					price: "0.009000",
					fee: "0.000100",
					action: "buy",
					outcomeSide: "no",
				},
			],
		});
		assert.equal(done.resubmits, 0);
		assert.equal((await ledger.status()).cash, "4.995400");
		await reconcileFromReads(ledger, {
			ordersComplete: true,
			fillsComplete: true,
			orders: [],
			fills: [
				{
					fill_id: "fill-subcent",
					order_id: "ord-recon",
					client_order_id: "recon-1",
					ticker: "KXBTC15M-TEST",
					count_fp: "0.50",
					price: "0.009000",
					fee: "0.000100",
					action: "buy",
					outcomeSide: "no",
				},
			],
		});
		assert.equal((await ledger.status()).cash, "4.995400");
		assert.equal(submits, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("read pages keep 400, changing pages, and equal-timestamp fills distinct", async () => {
	let fillsCall = 0;
	const portfolio = {
		async getBalance() {
			return { balance: 1, balance_dollars: "9.990000" };
		},
		async getPositions() {
			throw new Error("400 bad request");
		},
		async getFills() {
			fillsCall += 1;
			if (fillsCall === 1) {
				return {
					fills: [
						{ fill_id: "a", created_time: "2026-11-07T19:00:00.000Z" },
						{ fill_id: "b", created_time: "2026-11-07T19:00:00.000Z" },
					],
					cursor: "page-2",
				};
			}
			return {
				fills: [{ fill_id: "c", created_time: "2026-11-07T19:00:01.000Z" }],
				cursor: "",
			};
		},
		async getSettlements() {
			return { settlements: [] };
		},
	};
	const service = new AccountReadService(
		portfolio as never,
		{
			async getOrders() {
				return { orders: [] };
			},
		} as never,
	);
	const broken = await service.readPositions({});
	assert.equal(broken.status, "error");
	assert.equal(broken.terminal, false);
	assert.equal(broken.items.length, 0);
	const fills = await service.readFills({});
	assert.equal(fills.status, "complete");
	assert.deepEqual(
		fills.items.map((fill) => fill.fill_id),
		["a", "b", "c"],
	);
	const balance = await service.readBalance();
	assert.match(balance.conflicts.join(" "), /disagree/);
	assert.match(balance.balance_dollars, /9\.990000/);
});
