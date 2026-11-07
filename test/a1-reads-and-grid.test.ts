import assert from "node:assert/strict";
import { test } from "node:test";
import { PortfolioApi } from "kalshi-typescript";
import { formatPacific } from "../src/lib/pst.js";
import {
	TAPERED_DECI_CENT,
	priceOnGrid,
	toGridCreateOrder,
} from "../src/orders/price-grid.js";
import { AccountReadService } from "../src/reads/account-read-service.js";
import { RateLimitedError } from "../src/reads/paginate.js";
import { OrdersService } from "../src/services/orders-service.js";
import { PortfolioService } from "../src/services/portfolio-service.js";
import { createA1Tools } from "../src/tools/a1.js";
import { createOrderTools } from "../src/tools/orders.js";
import {
	OFFLINE_BASE,
	installOfflineTransport,
	requestBody,
} from "./offline-transport.js";

const now = new Date("2026-11-07T20:00:00.000Z");
const fresh = "2026-11-07T19:59:30.000Z";

test("Pacific rendering keeps the original instant and names PST or PDT", () => {
	const winter = formatPacific("2026-11-07T19:00:00.000Z");
	assert.equal(winter.original, "2026-11-07T19:00:00.000Z");
	assert.match(winter.pacific, /2026-11-07 11:00:00 PST/);
	const summer = formatPacific("2026-07-07T19:00:00.000Z");
	assert.match(summer.pacific, /2026-07-07 12:00:00 PDT/);
	assert.equal(formatPacific(undefined).pacific, "UNKNOWN");
});

test("tapered grid accepts edge ticks and rejects off-grid and stale metadata", () => {
	assert.equal(priceOnGrid("0.099000", TAPERED_DECI_CENT), true);
	assert.equal(priceOnGrid("0.101000", TAPERED_DECI_CENT), false);
	assert.equal(priceOnGrid("0.100000", TAPERED_DECI_CENT), true);
	assert.equal(priceOnGrid("0.110000", TAPERED_DECI_CENT), true);
	assert.equal(priceOnGrid("0.901000", TAPERED_DECI_CENT), true);
	assert.equal(priceOnGrid("0.000000", TAPERED_DECI_CENT), false);
	const order = toGridCreateOrder(
		{
			ticker: "KXBTC15M-TEST",
			side: "no",
			action: "buy",
			count: 5,
			noPriceDollars: "0.870000",
			priceRanges: TAPERED_DECI_CENT,
			priceObservedAt: fresh,
			now,
		},
		now,
	);
	assert.equal(order.side, "ask");
	assert.equal(order.price, "0.130000");
	assert.throws(
		() =>
			toGridCreateOrder({
				ticker: "KXBTC15M-TEST",
				side: "yes",
				action: "buy",
				count: 1,
				yesPriceDollars: "0.101000",
				priceRanges: TAPERED_DECI_CENT,
				priceObservedAt: fresh,
				now,
			}),
		/off the current market grid/,
	);
	assert.throws(
		() =>
			toGridCreateOrder({
				ticker: "KXBTC15M-TEST",
				side: "yes",
				action: "buy",
				count: 1,
				yesPriceDollars: "0.450000",
				priceRanges: TAPERED_DECI_CENT,
				priceObservedAt: "2026-11-07T18:00:00.000Z",
				now,
			}),
		/stale/,
	);
	assert.throws(
		() =>
			toGridCreateOrder({
				ticker: "KXBTC15M-TEST",
				side: "yes",
				action: "buy",
				count: 1,
				yesPriceDollars: "0.450000",
				now,
			}),
		/absent/,
	);
});

test("structured reads keep signs, dollars, cursors, and do not zero missing fields", async () => {
	const portfolio = {
		async getBalance() {
			return {
				balance: 250,
				balance_dollars: "2.500000",
				portfolio_value: 125,
				updated_ts: Date.parse("2026-11-07T19:00:00.000Z"),
			};
		},
		async getPositions() {
			return {
				market_positions: [
					{
						ticker: "KXBTC15M-TEST",
						position_fp: "-129.39",
						market_exposure_dollars: "40.120000",
						total_traded_dollars: "10.000000",
						realized_pnl_dollars: "1.250000",
						fees_paid_dollars: "0.020000",
						exchange_index: 2,
						last_updated_ts: "2026-11-07T19:00:00.000Z",
					},
					{
						ticker: "SENATEAK-TEST",
						exchange_index: 0,
					},
				],
				cursor: "",
			};
		},
		async getFills() {
			return { fills: [], cursor: "next" };
		},
		async getSettlements() {
			return { settlements: [] };
		},
	};
	const orders = {
		async getOrders() {
			return { orders: [] };
		},
	};
	const service = new AccountReadService(portfolio as never, orders as never);
	const tools = createA1Tools(service);
	const balance = await tools[0].execute();
	assert.match(balance, /balance_dollars: 2\.500000 dollars/);
	assert.match(balance, /250 cents/);
	assert.doesNotMatch(balance, /\$0\.03/);
	const positions = await tools[1].execute({});
	assert.match(positions, /position -129\.39 contracts/);
	assert.match(positions, /UNKNOWN/);
	assert.match(positions, /11:00:00 PST/);
	assert.match(positions, /status: complete/);
	assert.match(positions, /cursor: none/);
	const fills = await tools[3].execute({ maxPages: 1 });
	assert.match(fills, /status: partial/);
	assert.match(fills, /cursor: next/);
	assert.match(fills, /terminal: false/);
});

test("pagination separates empty, repeated cursors, errors, duplicates, and 429 retries", async () => {
	const pages: Array<{
		items: Array<{ fill_id: string; created_time: string }>;
		cursor: string | null;
		fail?: "429" | "down";
	}> = [
		{
			items: [
				{ fill_id: "f1", created_time: "2026-11-07T19:00:00Z" },
				{ fill_id: "f1", created_time: "2026-11-07T19:00:00Z" },
				{ fill_id: "f2", created_time: "2026-11-07T19:00:00Z" },
			],
			cursor: "c1",
		},
		{ items: [], cursor: "c2", fail: "429" },
		{ items: [], cursor: "c2" },
	];
	let calls = 0;
	const portfolio = {
		async getBalance() {
			return {};
		},
		async getPositions() {
			throw new Error("market_positions is absent");
		},
		async getFills() {
			calls += 1;
			const next = pages[Math.min(calls - 1, 1)];
			if (calls === 2) throw new RateLimitedError();
			if (calls === 3) return { fills: next?.items ?? [], cursor: "c1" };
			return { fills: pages[0]?.items, cursor: pages[0]?.cursor };
		},
		async getSettlements() {
			return { settlements: [{ ticker: "M", settled_time: "t", revenue: 0 }] };
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
	const fills = await service.readFills({ maxPages: 5 });
	assert.equal(fills.items.length, 2);
	assert.equal(fills.status, "truncated");
	assert.match(fills.reason ?? "", /repeated cursor/);
	assert.equal(calls, 3);
	const missing = await service.readPositions({});
	assert.equal(missing.status, "error");
	assert.equal(missing.items.length, 0);
	assert.equal(missing.terminal, false);
	assert.equal(missing.watermark, null);
});

test("getPositions still places ticker after the SDK settlementStatus slot", async () => {
	const { calls, http } = installOfflineTransport(async () => ({
		market_positions: [],
		event_positions: [],
		cursor: "",
	}));
	const portfolio = new PortfolioService(
		new PortfolioApi(undefined, OFFLINE_BASE, http),
	);
	const service = new AccountReadService(portfolio, {
		async getOrders() {
			return { orders: [], cursor: "" };
		},
	} as never);
	await service.readPositions({ ticker: "ABC", eventTicker: "EVT" });
	const url = new URL(calls[0]?.url ?? "");
	assert.equal(url.searchParams.get("ticker"), "ABC");
	assert.equal(url.searchParams.get("event_ticker"), "EVT");
	assert.equal(url.searchParams.get("settlement_status"), null);
});

test("legacy cent create acknowledgement is unchanged and keeps a caller id", async () => {
	const { calls, http } = installOfflineTransport(async () => ({
		order_id: "ord-1",
		client_order_id: "caller-stable",
		fill_count: "0.00",
		remaining_count: "5.00",
		ts_ms: 1,
	}));
	const { OrdersApi } = await import("kalshi-typescript");
	const tools = createOrderTools(
		new OrdersService({
			ordersApi: new OrdersApi(undefined, OFFLINE_BASE, http),
			createClientOrderId: () => "generated",
		}),
	);
	const create = tools.find((tool) => tool.name === "CREATE_ORDER");
	assert.ok(create);
	const text = await create.execute({
		ticker: "MKT",
		side: "no",
		action: "buy",
		count: 5,
		type: "limit",
		noPrice: 87,
		clientOrderId: "caller-stable",
	});
	assert.equal(calls.length, 1);
	assert.ok(calls[0]);
	assert.equal(requestBody(calls[0]).client_order_id, "caller-stable");
	assert.match(text, /Submitted YES-book side: ask/);
	assert.match(text, /Submitted YES price \(\$\): 0\.1300/);
	assert.match(text, /Client order ID: caller-stable/);
	assert.match(text, /Do not add the fill count and remaining count/);
});
