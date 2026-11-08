import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { AxiosError } from "axios";
import { OrdersApi } from "kalshi-typescript";
import { toCreateOrderV2 } from "../src/services/create-order-v2-adapter.js";
import {
	OrderMutationClosedError,
	OrdersService,
} from "../src/services/orders-service.js";
import { createOrderParams, createOrderTools } from "../src/tools/orders.js";
import {
	type CapturedRequest,
	OFFLINE_BASE,
	installOfflineTransport,
	requestBody,
} from "./offline-transport.js";

let socketAttempts = 0;
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function blockedConnect(
	this: net.Socket,
	...args: unknown[]
) {
	socketAttempts += 1;
	throw new Error(`network disabled: ${String(args[0])}`);
};
process.on("exit", () => {
	net.Socket.prototype.connect = originalConnect;
});

function toolByName<T extends { name: string }>(
	tools: readonly T[],
	name: string,
): T {
	const found = tools.find((tool) => tool.name === name);
	assert.ok(found, name);
	return found;
}

function ordersApi(
	handler: (request: CapturedRequest) => unknown | Promise<unknown>,
) {
	const transport = installOfflineTransport(handler);
	const api = new OrdersApi(undefined, OFFLINE_BASE, transport.http);
	return { ...transport, api };
}

const ack = {
	order_id: "ord-1",
	client_order_id: "caller-1",
	fill_count: "0.00",
	remaining_count: "5.00",
	ts_ms: 1715793600123,
};

test("legacy order mutations are absent and V2 methods exist", () => {
	const proto = OrdersApi.prototype as unknown as Record<string, unknown>;
	for (const removed of [
		"createOrder",
		"cancelOrder",
		"amendOrder",
		"decreaseOrder",
		"batchCreateOrders",
		"batchCancelOrders",
	]) {
		assert.equal(proto[removed], undefined, removed);
	}
	for (const present of [
		"createOrderV2",
		"cancelOrderV2",
		"amendOrderV2",
		"decreaseOrderV2",
		"batchCreateOrdersV2",
		"batchCancelOrdersV2",
		"getOrders",
		"getOrder",
	]) {
		assert.equal(typeof proto[present], "function", present);
	}
});

test("YES/NO buy/sell map onto the YES book with complemented dollar prices", () => {
	const cases = [
		{
			side: "yes" as const,
			action: "buy" as const,
			yesPrice: 45,
			book: "bid",
			price: "0.4500",
		},
		{
			side: "yes" as const,
			action: "sell" as const,
			yesPrice: 45,
			book: "ask",
			price: "0.4500",
		},
		{
			side: "no" as const,
			action: "buy" as const,
			noPrice: 87,
			book: "ask",
			price: "0.1300",
		},
		{
			side: "no" as const,
			action: "sell" as const,
			noPrice: 87,
			book: "bid",
			price: "0.1300",
		},
		{
			side: "no" as const,
			action: "buy" as const,
			noPrice: 1,
			book: "ask",
			price: "0.9900",
		},
		{
			side: "no" as const,
			action: "sell" as const,
			noPrice: 99,
			book: "bid",
			price: "0.0100",
		},
		{
			side: "yes" as const,
			action: "buy" as const,
			yesPrice: 1,
			book: "bid",
			price: "0.0100",
		},
		{
			side: "yes" as const,
			action: "sell" as const,
			yesPrice: 99,
			book: "ask",
			price: "0.9900",
		},
	];
	for (const entry of cases) {
		const request = toCreateOrderV2({
			ticker: "HIGHNY-24JAN01-T60",
			side: entry.side,
			action: entry.action,
			count: 5,
			yesPrice: entry.yesPrice,
			noPrice: entry.noPrice,
		});
		assert.equal(request.side, entry.book, `${entry.side} ${entry.action}`);
		assert.equal(request.price, entry.price);
		assert.equal(request.count, "5.00");
		assert.equal(request.time_in_force, "good_till_canceled");
		assert.equal(request.self_trade_prevention_type, "taker_at_cross");
		assert.equal(request.exchange_index, undefined);
		assert.equal(request.subaccount, undefined);
		assert.equal("action" in request, false);
		assert.equal("yes_price" in request, false);
		assert.equal("type" in request, false);
	}
});

test("consistent dual prices use the selected outcome and inconsistent prices are rejected", () => {
	const request = toCreateOrderV2({
		ticker: "MKT",
		side: "no",
		action: "buy",
		count: 2,
		yesPrice: 13,
		noPrice: 87,
	});
	assert.equal(request.side, "ask");
	assert.equal(request.price, "0.1300");
	assert.throws(
		() =>
			toCreateOrderV2({
				ticker: "MKT",
				side: "no",
				action: "buy",
				count: 2,
				yesPrice: 20,
				noPrice: 87,
			}),
		/Inconsistent YES\/NO limit prices/,
	);
	assert.throws(
		() =>
			toCreateOrderV2({
				ticker: "MKT",
				side: "yes",
				action: "buy",
				count: 2,
				noPrice: 13,
			}),
		/Selected outcome requires/,
	);
});

test("invalid create inputs are rejected before a request exists", () => {
	const base = {
		ticker: "MKT",
		side: "yes" as const,
		action: "buy" as const,
		count: 1,
		yesPrice: 40,
	};
	const rejected: Array<[Record<string, unknown>, RegExp]> = [
		[{ type: "market" }, /Market orders are disabled/],
		[{ count: 0 }, /Whole positive contract count/],
		[{ count: -3 }, /Whole positive contract count/],
		[{ count: 1.5 }, /Whole positive contract count/],
		[{ count: Number.NaN }, /Whole positive contract count/],
		[{ count: Number.POSITIVE_INFINITY }, /Whole positive contract count/],
		[{ yesPrice: undefined }, /Selected outcome requires/],
		[{ yesPrice: 0 }, /yesPrice must be a whole-cent/],
		[{ yesPrice: 100 }, /yesPrice must be a whole-cent/],
		[{ yesPrice: 40.5 }, /yesPrice must be a whole-cent/],
		[{ ticker: "  " }, /ticker is required/],
		[{ side: "YES" }, /side must be yes or no/],
		[{ action: "long" }, /action must be buy or sell/],
		[{ timeInForce: "GTT" }, /Invalid time_in_force/],
		[{ timeInForce: "good_till_date" }, /Invalid time_in_force/],
		[
			{ reduceOnly: true, timeInForce: "good_till_canceled" },
			/reduce_only requires immediate_or_cancel/,
		],
		[
			{ postOnly: true, timeInForce: "immediate_or_cancel" },
			/post_only requires/,
		],
		[
			{ expirationTs: 1_700_000_000, timeInForce: "immediate_or_cancel" },
			/expiration_time requires/,
		],
		[
			{ expirationTs: 1_700_000_000, timeInForce: "fill_or_kill" },
			/expiration_time requires/,
		],
		[{ expirationTs: 0 }, /expiration_time requires/],
		[{ expirationTs: 1.5 }, /expiration_time requires/],
		[{ expirationTs: -10 }, /expiration_time requires/],
		[{ clientOrderId: "  " }, /client_order_id/],
	];
	for (const [override, pattern] of rejected) {
		assert.throws(
			() => toCreateOrderV2({ ...base, ...override }),
			pattern,
			JSON.stringify(override),
		);
	}
});

test("explicit limit controls are preserved and omitted controls stay omitted", () => {
	const resting = toCreateOrderV2({
		ticker: "MKT",
		side: "yes",
		action: "sell",
		count: 4,
		yesPrice: 60,
		timeInForce: "good_till_canceled",
		expirationTs: 1_700_000_000,
		postOnly: true,
		clientOrderId: "keep-me",
	});
	assert.equal(resting.time_in_force, "good_till_canceled");
	assert.equal(resting.expiration_time, 1_700_000_000);
	assert.equal(resting.post_only, true);
	assert.equal(resting.client_order_id, "keep-me");
	assert.equal(resting.reduce_only, undefined);

	const reducing = toCreateOrderV2({
		ticker: "MKT",
		side: "no",
		action: "sell",
		count: 3,
		noPrice: 25,
		timeInForce: "immediate_or_cancel",
		reduceOnly: true,
		postOnly: false,
	});
	assert.equal(reducing.side, "bid");
	assert.equal(reducing.price, "0.7500");
	assert.equal(reducing.time_in_force, "immediate_or_cancel");
	assert.equal(reducing.reduce_only, true);
	assert.equal(reducing.post_only, false);
	assert.equal(reducing.expiration_time, undefined);
});

test("createOrderV2 sends one offline request and preserves a caller id", async () => {
	const { calls, api } = ordersApi(async () => ack);
	let generated = 0;
	const service = new OrdersService({
		profile: "a2",
		ordersApi: api,
		createClientOrderId: () => {
			generated += 1;
			return "generated-should-not-run";
		},
	});
	const result = await service.createOrder({
		ticker: "HIGHNY-24JAN01-T60",
		side: "no",
		action: "buy",
		count: 5,
		noPrice: 87,
		clientOrderId: "caller-1",
	});
	assert.equal(calls.length, 1);
	assert.equal(generated, 0);
	assert.equal(calls[0]?.method, "POST");
	assert.equal(calls[0]?.url, `${OFFLINE_BASE}/portfolio/events/orders`);
	assert.deepEqual(requestBody(calls[0] as CapturedRequest), {
		ticker: "HIGHNY-24JAN01-T60",
		client_order_id: "caller-1",
		side: "ask",
		count: "5.00",
		price: "0.1300",
		time_in_force: "good_till_canceled",
		self_trade_prevention_type: "taker_at_cross",
	});
	assert.deepEqual(result, ack);
});

test("a generated client id is assigned once and a timeout is not retried", async () => {
	const { calls, api } = ordersApi(async () => {
		throw new AxiosError("timeout", "ECONNABORTED");
	});
	let generated = 0;
	const service = new OrdersService({
		profile: "a2",
		ordersApi: api,
		createClientOrderId: () => `id-${++generated}`,
	});
	await assert.rejects(
		service.createOrder({
			ticker: "MKT",
			side: "yes",
			action: "buy",
			count: 1,
			yesPrice: 40,
		}),
		/timeout/,
	);
	assert.equal(generated, 1);
	assert.equal(calls.length, 1);
	assert.equal(
		requestBody(calls[0] as CapturedRequest).client_order_id,
		"id-1",
	);
});

test("invalid create input performs zero SDK calls", async () => {
	const { calls, api } = ordersApi(async () => ack);
	const service = new OrdersService({ profile: "a2", ordersApi: api });
	await assert.rejects(
		service.createOrder({
			ticker: "MKT",
			side: "yes",
			action: "buy",
			count: 1.2,
			yesPrice: 40,
		}),
		/Whole positive contract count/,
	);
	assert.equal(calls.length, 0);
});

test("CREATE_ORDER presents the flat V2 acknowledgement and partial IOC remainder", async () => {
	const { calls, api } = ordersApi(async () => ({
		order_id: "ord-ioc",
		client_order_id: "id-1",
		fill_count: "3.00",
		remaining_count: "0.00",
		average_fill_price: "0.130000",
		average_fee_paid: "0.002000",
		ts_ms: 1715793600456,
	}));
	const tools = createOrderTools(
		new OrdersService({
			profile: "a2",
			ordersApi: api,
			createClientOrderId: () => "id-1",
		}),
	);
	const create = toolByName(tools, "CREATE_ORDER");
	const text = await create.execute({
		ticker: "MKT",
		side: "no",
		action: "buy",
		count: 5,
		type: "limit",
		noPrice: 87,
		timeInForce: "immediate_or_cancel",
	});
	assert.equal(calls.length, 1);
	assert.match(text, /not a fill or status guarantee/);
	assert.match(text, /Order ID: ord-ioc/);
	assert.match(text, /Submitted YES-book side: ask/);
	assert.match(text, /Submitted YES price \(\$\): 0\.1300/);
	assert.match(text, /Immediate fill count: 3\.00/);
	assert.match(text, /Remaining count: 0\.00/);
	assert.match(text, /Requested count: 5\.00/);
	assert.match(text, /Do not add the fill count and remaining count/);
	assert.match(text, /Average fill YES price \(\$\): 0\.130000/);
	assert.match(text, /Average fee per contract \(\$\): 0\.002000/);
	assert.doesNotMatch(text, /Order created successfully/);
	assert.doesNotMatch(text, /Status:/);
	assert.equal(
		requestBody(calls[0] as CapturedRequest).time_in_force,
		"immediate_or_cancel",
	);
});

test("CREATE_ORDER rejects a market order before any request", async () => {
	const { calls, api } = ordersApi(async () => ack);
	const tools = createOrderTools(
		new OrdersService({ profile: "a2", ordersApi: api }),
	);
	const create = toolByName(tools, "CREATE_ORDER");
	const text = await create.execute({
		ticker: "MKT",
		side: "yes",
		action: "buy",
		count: 1,
		type: "market",
		yesPrice: 40,
	});
	assert.match(text, /Market orders are disabled/);
	assert.equal(calls.length, 0);
});

test("public create schema rejects fractional count and price before execute", () => {
	assert.throws(
		() =>
			createOrderParams.parse({
				ticker: "MKT",
				side: "yes",
				action: "buy",
				count: 1.5,
				yesPrice: 40,
			}),
		/integer|whole/i,
	);
	assert.throws(
		() =>
			createOrderParams.parse({
				ticker: "MKT",
				side: "no",
				action: "buy",
				count: 1,
				noPrice: 87.5,
			}),
		/integer|whole/i,
	);
});

test("cancel auto-routes with the market ticker and does not invent a fill", async () => {
	const { calls, api } = ordersApi(async () => ({
		order_id: "ord-1",
		client_order_id: "caller-1",
		reduced_by: "10.00",
		ts_ms: 1715793660456,
	}));
	const tools = createOrderTools(
		new OrdersService({ profile: "a2", ordersApi: api }),
	);
	const cancel = toolByName(tools, "CANCEL_ORDER");
	const text = await cancel.execute({
		orderId: "ord-1",
		marketTicker: "HIGHNY-24JAN01-T60",
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.method, "DELETE");
	const url = new URL(calls[0]?.url ?? "");
	assert.equal(url.pathname, "/trade-api/v2/portfolio/events/orders/ord-1");
	assert.equal(url.searchParams.get("exchange_index"), "-1");
	assert.equal(url.searchParams.get("market_ticker"), "HIGHNY-24JAN01-T60");
	assert.equal(url.searchParams.get("subaccount"), null);
	assert.match(text, /Reduced by: 10\.00/);
	assert.match(text, /not a full order snapshot/);
	assert.doesNotMatch(text, /Filled before cancel/);
	assert.doesNotMatch(text, /Final Status/);
});

test("cancel and decrease without a market ticker make zero requests", async () => {
	const { calls, api } = ordersApi(async () => {
		throw new Error("should not be called");
	});
	const service = new OrdersService({ profile: "a2", ordersApi: api });
	await assert.rejects(
		service.cancelOrder({ orderId: "ord-1", marketTicker: " " }),
		/Refusing to default to exchange shard 0/,
	);
	await assert.rejects(
		service.decreaseOrder({
			orderId: "ord-1",
			reduceBy: 1,
			marketTicker: "",
		}),
		/Refusing to default to exchange shard 0/,
	);
	await assert.rejects(
		service.batchCancelOrders({ ids: ["ord-1", "ord-2"] }),
		/Refusing to default to exchange shard 0/,
	);
	assert.equal(calls.length, 0);
});

test("decrease sends reduce_by only and presents remaining_count", async () => {
	const { calls, api } = ordersApi(async () => ({
		order_id: "ord-1",
		client_order_id: "caller-1",
		remaining_count: "8.00",
		ts_ms: 1715793680789,
	}));
	const tools = createOrderTools(
		new OrdersService({ profile: "a2", ordersApi: api }),
	);
	const decrease = toolByName(tools, "DECREASE_ORDER");
	const text = await decrease.execute({
		orderId: "ord-1",
		reduceBy: 2,
		marketTicker: "MKT",
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.method, "POST");
	assert.equal(
		calls[0]?.url,
		`${OFFLINE_BASE}/portfolio/events/orders/ord-1/decrease`,
	);
	assert.deepEqual(requestBody(calls[0] as CapturedRequest), {
		reduce_by: "2.00",
		market_ticker: "MKT",
		exchange_index: -1,
	});
	assert.match(text, /Remaining count: 8\.00/);
	assert.doesNotMatch(text, /Status:/);
	await assert.rejects(
		new OrdersService({ profile: "a2", ordersApi: api }).decreaseOrder({
			orderId: "ord-1",
			reduceBy: 1.5,
			marketTicker: "MKT",
		}),
		/whole positive contract count/,
	);
	assert.equal(calls.length, 1);
});

test("batch cancel is one request and partial errors stay visible", async () => {
	const { calls, api } = ordersApi(async () => ({
		orders: [
			{
				order_id: "ord-1",
				client_order_id: "c1",
				reduced_by: "10.00",
				ts_ms: 1715793660456,
			},
			{
				order_id: "ord-2",
				reduced_by: "0.00",
				error: { code: "not_found", message: "order not found" },
			},
		],
	}));
	const tools = createOrderTools(
		new OrdersService({ profile: "a2", ordersApi: api }),
	);
	const batch = toolByName(tools, "BATCH_CANCEL_ORDERS");
	const text = await batch.execute({
		orders: [
			{ orderId: "ord-1", marketTicker: "MKT-A" },
			{ orderId: "ord-2", marketTicker: "MKT-B" },
		],
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.method, "DELETE");
	assert.equal(
		calls[0]?.url,
		`${OFFLINE_BASE}/portfolio/events/orders/batched`,
	);
	assert.deepEqual(requestBody(calls[0] as CapturedRequest), {
		orders: [
			{ order_id: "ord-1", market_ticker: "MKT-A", exchange_index: -1 },
			{ order_id: "ord-2", market_ticker: "MKT-B", exchange_index: -1 },
		],
	});
	assert.match(text, /Entries: 2/);
	assert.match(text, /Entries with error: 1/);
	assert.match(text, /ord-2: reduced_by 0\.00 error: order not found/);
	assert.doesNotMatch(text, /Canceled: 2/);
});

test("amend and batch create stay fail-closed with zero requests", async () => {
	const { calls, api } = ordersApi(async () => {
		throw new Error("should not be called");
	});
	const service = new OrdersService({ profile: "a2", ordersApi: api });
	await assert.rejects(
		service.amendOrder({
			orderId: "ord-1",
			ticker: "MKT",
			side: "yes",
			action: "buy",
			clientOrderId: "old",
			updatedClientOrderId: "new",
			count: 8,
			yesPrice: 57,
		}),
		OrderMutationClosedError,
	);
	await assert.rejects(
		service.batchCreateOrders({
			orders: [
				{
					ticker: "MKT",
					side: "yes",
					action: "buy",
					count: 1,
					yesPrice: 40,
				},
			],
		}),
		/exactly one order/,
	);
	assert.equal(calls.length, 0);
});

test("get order and get orders read fixed-point fields", async () => {
	const { api } = ordersApi(async (request) => {
		if (request.url.endsWith("/portfolio/orders/ord-1")) {
			return {
				order: {
					order_id: "ord-1",
					ticker: "MKT",
					book_side: "bid",
					outcome_side: "yes",
					status: "resting",
					initial_count_fp: "5.00",
					fill_count_fp: "1.00",
					remaining_count_fp: "4.00",
					yes_price_dollars: "0.4500",
					no_price_dollars: "0.5500",
					created_time: "2026-06-01T00:00:00Z",
					last_update_time: null,
				},
			};
		}
		return {
			orders: [
				{
					order_id: "ord-1",
					ticker: "MKT",
					book_side: "bid",
					outcome_side: "yes",
					status: "resting",
					initial_count_fp: "5.00",
					remaining_count_fp: "4.00",
					yes_price_dollars: "0.4500",
				},
			],
		};
	});
	const tools = createOrderTools(
		new OrdersService({ profile: "a2", ordersApi: api }),
	);
	const list = await toolByName(tools, "GET_ORDERS").execute({});
	const detail = await toolByName(tools, "GET_ORDER").execute({
		orderId: "ord-1",
	});
	assert.match(
		list,
		/book bid \/ outcome yes remaining 4\.00\/5\.00 YES \$0\.4500/,
	);
	assert.doesNotMatch(list, /¢/);
	assert.match(detail, /YES price \(\$\): 0\.4500/);
	assert.match(detail, /Initial: 5\.00/);
	assert.doesNotMatch(detail, /¢/);
});

test("offline transport opened no sockets", () => {
	assert.equal(socketAttempts, 0);
});
