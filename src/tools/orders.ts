import dedent from "dedent";
import { z } from "zod";
import { toGridCreateOrder, usesDollarPrices } from "../orders/price-grid.js";
import { toCreateOrderV2 } from "../services/create-order-v2-adapter.js";
import { OrdersService } from "../services/orders-service.js";

const routedOrder = z.object({
	orderId: z.string().min(1).describe("The order ID"),
	marketTicker: z
		.string()
		.min(1)
		.describe(
			"Market ticker. Required so the cancel auto-routes instead of defaulting to exchange shard 0.",
		),
});

const getOrdersParams = z.object({
	ticker: z.string().optional().describe("Filter by market ticker"),
	eventTicker: z
		.string()
		.optional()
		.describe("Filter by event ticker (comma-separated, max 10)"),
	status: z
		.enum(["resting", "canceled", "executed"])
		.optional()
		.describe("Filter by order status"),
	limit: z
		.number()
		.min(1)
		.max(200)
		.optional()
		.describe("Number of results (1-200, default 100)"),
	cursor: z.string().optional().describe("Pagination cursor"),
});

const getOrderParams = z.object({
	orderId: z.string().min(1).describe("The order ID"),
});

export const createOrderParams = z.object({
	ticker: z.string().min(1).describe("Market ticker to trade"),
	side: z.enum(["yes", "no"]).describe("Outcome to trade: 'yes' or 'no'"),
	action: z.enum(["buy", "sell"]).describe("Action: 'buy' or 'sell'"),
	count: z
		.number()
		.int()
		.min(1)
		.describe("Whole number of contracts. Fractional contracts are rejected."),
	type: z
		.enum(["limit", "market"])
		.optional()
		.default("limit")
		.describe(
			"Order type. Only limit is accepted. Market orders are rejected before any request is sent.",
		),
	yesPrice: z
		.number()
		.int()
		.min(1)
		.max(99)
		.optional()
		.describe(
			"YES limit in whole cents (1-99). Required when side is yes. Converted to a fixed-point YES dollar price.",
		),
	noPrice: z
		.number()
		.int()
		.min(1)
		.max(99)
		.optional()
		.describe(
			"Legacy NO limit in whole cents (1-99). Required when side is no and dollar prices are omitted. Complemented onto the YES book before submission.",
		),
	yesPriceDollars: z
		.string()
		.optional()
		.describe(
			"Exact YES dollar price. Requires current priceRanges. Omitted cent orders keep the legacy whole-cent path.",
		),
	noPriceDollars: z
		.string()
		.optional()
		.describe(
			"Exact NO dollar price. Requires current priceRanges. The YES-book complement is checked against the same grid.",
		),
	priceRanges: z
		.array(
			z.object({
				start: z.string(),
				end: z.string(),
				step: z.string(),
			}),
		)
		.optional()
		.describe(
			"Current market price_ranges. Required with dollar prices. Absent or stale metadata is rejected.",
		),
	priceObservedAt: z
		.string()
		.optional()
		.describe(
			"ISO time when priceRanges were read. Required with dollar prices.",
		),
	clientOrderId: z
		.string()
		.min(1)
		.max(64)
		.optional()
		.describe(
			"Stable caller idempotency key. If omitted, one new id is generated for this call only and is not recovered after a crash. The call is still not retried.",
		),
	timeInForce: z
		.enum(["fill_or_kill", "good_till_canceled", "immediate_or_cancel"])
		.optional()
		.describe(
			"Time in force. Defaults to good_till_canceled. GTT is not a valid value; use good_till_canceled with expirationTs.",
		),
	expirationTs: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Unix expiration in seconds. Only valid with good_till_canceled.",
		),
	postOnly: z
		.boolean()
		.optional()
		.describe(
			"If true, the order is placed only when it will rest. Requires good_till_canceled.",
		),
	reduceOnly: z
		.boolean()
		.optional()
		.describe(
			"If true, size is capped by the current position. Requires immediate_or_cancel.",
		),
});

const cancelOrderParams = z.object({
	orderId: z.string().min(1).describe("The order ID to cancel"),
	marketTicker: z
		.string()
		.min(1)
		.describe(
			"Market ticker of the order. Required for V2 auto-routing. An order id alone is rejected.",
		),
});

const batchCancelOrdersParams = z.object({
	orders: z
		.array(routedOrder)
		.min(1)
		.max(20)
		.describe(
			"Orders to cancel (max 20). Each entry needs an order id and its market ticker.",
		),
});

const decreaseOrderParams = z.object({
	orderId: z.string().min(1).describe("The order ID to decrease"),
	reduceBy: z
		.number()
		.int()
		.min(1)
		.describe("Whole number of contracts to remove from the resting size"),
	marketTicker: z
		.string()
		.min(1)
		.describe(
			"Market ticker of the order. Required for V2 auto-routing. An order id alone is rejected.",
		),
});

function shown(value: string | number | null | undefined): string {
	if (value === undefined || value === null || value === "") {
		return "not returned";
	}
	return String(value);
}

export function createOrderTools(ordersService = new OrdersService()) {
	const getOrdersTool = {
		name: "GET_ORDERS",
		description:
			"Get your orders with optional filtering by market, status, or time range. Prices are fixed-point YES dollars and sizes are fixed-point contract counts.",
		parameters: getOrdersParams,
		execute: async (params: z.infer<typeof getOrdersParams>) => {
			try {
				const result = await ordersService.getOrders(params);
				const orders = result.orders || [];
				if (orders.length === 0) {
					return "No orders found.";
				}
				const summary = orders
					.map((order) => {
						return `• ${order.order_id} ${order.ticker}: book ${order.book_side} / outcome ${order.outcome_side} remaining ${order.remaining_count_fp}/${order.initial_count_fp} YES $${order.yes_price_dollars} [${order.status}]`;
					})
					.join("\n");
				return dedent`
					Found ${orders.length} orders:

					${summary}
				`;
			} catch (error) {
				return `Error fetching orders: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	const getOrderTool = {
		name: "GET_ORDER",
		description:
			"Get detailed information about a specific order by its ID. Prices are fixed-point YES dollars and sizes are fixed-point contract counts.",
		parameters: getOrderParams,
		execute: async (params: z.infer<typeof getOrderParams>) => {
			try {
				const result = await ordersService.getOrder(params.orderId);
				const order = result.order;
				if (!order) {
					return `Order '${params.orderId}' not found.`;
				}
				return dedent`
					Order: ${order.order_id}
					Market: ${order.ticker}
					Book side: ${order.book_side}
					Outcome side: ${order.outcome_side}
					Status: ${order.status}

					Quantity (fixed-point contracts):
					• Initial: ${order.initial_count_fp}
					• Filled: ${order.fill_count_fp}
					• Remaining: ${order.remaining_count_fp}

					YES price ($): ${order.yes_price_dollars}
					NO price ($): ${order.no_price_dollars}

					Created: ${shown(order.created_time)}
					Last Updated: ${shown(order.last_update_time)}
				`;
			} catch (error) {
				return `Error fetching order: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	const createOrderTool = {
		name: "CREATE_ORDER",
		description:
			"Create one limit order. Legacy whole-cent YES/NO prices are mapped onto the YES book. Optional dollar prices require current priceRanges and are rejected when that grid is missing or stale. Optional clientOrderId is kept for this call; omitting it generates a new id and does not retry. The response is an acknowledgement, not a resting-order snapshot.",
		parameters: createOrderParams,
		execute: async (params: z.infer<typeof createOrderParams>) => {
			try {
				const now = new Date();
				const order = {
					ticker: params.ticker,
					side: params.side,
					action: params.action,
					count: params.count,
					type: params.type,
					yesPrice: params.yesPrice,
					noPrice: params.noPrice,
					yesPriceDollars: params.yesPriceDollars,
					noPriceDollars: params.noPriceDollars,
					priceRanges: params.priceRanges,
					priceObservedAt: params.priceObservedAt,
					timeInForce: params.timeInForce,
					expirationTs: params.expirationTs,
					postOnly: params.postOnly,
					reduceOnly: params.reduceOnly,
					clientOrderId: params.clientOrderId,
					now,
				};
				const result = await ordersService.createOrder(order);
				const submitted = usesDollarPrices(order)
					? toGridCreateOrder(order)
					: toCreateOrderV2(order);
				return dedent`
					Order acknowledgement received. This is not a fill or status guarantee.

					Order ID: ${shown(result.order_id)}
					Client order ID: ${shown(result.client_order_id)}
					Market: ${params.ticker}
					Requested: ${params.action} ${params.count} ${params.side}
					Submitted YES-book side: ${submitted.side}
					Submitted YES price ($): ${submitted.price}
					Submitted count: ${submitted.count}
					Self-trade prevention: ${submitted.self_trade_prevention_type}
					Immediate fill count: ${shown(result.fill_count)}
					Remaining count: ${shown(result.remaining_count)}
					Requested count: ${params.count.toFixed(2)}
					Do not add the fill count and remaining count to reconstruct size. For immediate_or_cancel, remaining count is the final remainder after unfilled contracts are canceled.
					Average fill YES price ($): ${shown(result.average_fill_price)}
					Average fee per contract ($): ${shown(result.average_fee_paid)}
					Engine timestamp (Unix ms): ${shown(result.ts_ms)}
				`;
			} catch (error) {
				return `Error creating order: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	const cancelOrderTool = {
		name: "CANCEL_ORDER",
		description:
			"Cancel one resting order. Requires the market ticker so the request auto-routes. The response reports reduced_by, not a full order or a fill count. The call is not retried.",
		parameters: cancelOrderParams,
		execute: async (params: z.infer<typeof cancelOrderParams>) => {
			try {
				const result = await ordersService.cancelOrder({
					orderId: params.orderId,
					marketTicker: params.marketTicker,
				});
				return dedent`
					Cancel acknowledgement received. This is not a full order snapshot.

					Order ID: ${shown(result.order_id)}
					Client order ID: ${shown(result.client_order_id)}
					Reduced by: ${shown(result.reduced_by)} contracts
					Engine timestamp (Unix ms): ${shown(result.ts_ms)}
				`;
			} catch (error) {
				return `Error canceling order: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	const batchCancelOrdersTool = {
		name: "BATCH_CANCEL_ORDERS",
		description:
			"Cancel up to 20 orders. Each order needs its market ticker. Partial failures stay in the acknowledgement and are not retried.",
		parameters: batchCancelOrdersParams,
		execute: async (params: z.infer<typeof batchCancelOrdersParams>) => {
			try {
				const result = await ordersService.batchCancelOrders({
					orders: params.orders,
				});
				const orders = result.orders ?? [];
				const failed = orders.filter((order) => order.error);
				const lines = orders
					.map((order) => {
						const errorText = order.error?.message
							? ` error: ${order.error.message}`
							: "";
						return `• ${order.order_id}: reduced_by ${shown(order.reduced_by)}${errorText}`;
					})
					.join("\n");
				return dedent`
					Batch cancel acknowledgement received. This does not guarantee every order was canceled.

					Entries: ${orders.length}
					Entries with error: ${failed.length}

					${lines}
				`;
			} catch (error) {
				return `Error canceling orders: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	const decreaseOrderTool = {
		name: "DECREASE_ORDER",
		description:
			"Decrease the resting size of one order by a whole contract count. Requires the market ticker. The response reports remaining_count and is not retried.",
		parameters: decreaseOrderParams,
		execute: async (params: z.infer<typeof decreaseOrderParams>) => {
			try {
				const result = await ordersService.decreaseOrder({
					orderId: params.orderId,
					reduceBy: params.reduceBy,
					marketTicker: params.marketTicker,
				});
				return dedent`
					Decrease acknowledgement received. This is not an order status.

					Order ID: ${shown(result.order_id)}
					Client order ID: ${shown(result.client_order_id)}
					Remaining count: ${shown(result.remaining_count)}
					Engine timestamp (Unix ms): ${shown(result.ts_ms)}
				`;
			} catch (error) {
				return `Error decreasing order: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	return [
		getOrdersTool,
		getOrderTool,
		createOrderTool,
		cancelOrderTool,
		batchCancelOrdersTool,
		decreaseOrderTool,
	] as const;
}

export const orderTools = createOrderTools();
