import { randomUUID } from "node:crypto";
import type { CreateOrderV2Response, OrdersApi } from "kalshi-typescript";
import {
	type GridLimitInput,
	toGridCreateOrder,
	usesDollarPrices,
} from "../orders/price-grid.js";
import {
	type McpProfile,
	assertA2Mutation,
	resolveProfile,
} from "../profile.js";
import {
	type LegacyCreateInput,
	toCreateOrderV2,
} from "./create-order-v2-adapter.js";
import { KalshiClient } from "./kalshi-client.js";

export interface GetOrdersParams {
	ticker?: string;
	eventTicker?: string;
	minTs?: number;
	maxTs?: number;
	status?: string;
	limit?: number;
	cursor?: string;
}

export interface CreateOrderParams
	extends LegacyCreateInput,
		Pick<
			GridLimitInput,
			| "yesPriceDollars"
			| "noPriceDollars"
			| "priceRanges"
			| "priceObservedAt"
			| "now"
			| "maxMetadataAgeMs"
		> {}

export interface AmendOrderParams {
	orderId: string;
	ticker: string;
	side: "yes" | "no";
	action: "buy" | "sell";
	clientOrderId: string;
	updatedClientOrderId: string;
	count?: number;
	yesPrice?: number;
	noPrice?: number;
}

export interface DecreaseOrderParams {
	orderId: string;
	reduceBy: number;
	marketTicker: string;
}

export interface BatchCreateOrdersParams {
	orders: CreateOrderParams[];
}

export interface RoutedOrderId {
	orderId: string;
	marketTicker: string;
}

export interface BatchCancelOrdersParams {
	orders?: RoutedOrderId[];
	/** Legacy id-only input. Rejected: V2 cannot route an order id without a market ticker. */
	ids?: string[];
}

export interface CancelOrderParams {
	orderId: string;
	marketTicker: string;
}

export interface GetOrderQueuePositionsParams {
	marketTickers?: string;
	eventTicker?: string;
}

export class OrderMutationClosedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrderMutationClosedError";
	}
}

export interface OrdersServiceOptions {
	ordersApi?: OrdersApi;
	createClientOrderId?: () => string;
	/** Defaults to the process profile, which is a1 unless KALSHI_MCP_PROFILE=a2. */
	profile?: McpProfile;
}

const SHARD_DEFAULT_REFUSAL =
	"market_ticker is required to auto-route this request. Refusing to default to exchange shard 0.";

function requireText(value: string, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${label} is required`);
	}
	return value.trim();
}

function requireMarketTicker(value: string | undefined): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(SHARD_DEFAULT_REFUSAL);
	}
	return value.trim();
}

function requireWholeCount(value: number, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${label} must be a whole positive contract count`);
	}
	return value;
}

export class OrdersService {
	private readonly ordersApi: OrdersApi | undefined;
	private readonly createClientOrderId: () => string;
	private readonly profile: McpProfile;

	constructor(options: OrdersServiceOptions = {}) {
		this.ordersApi = options.ordersApi;
		this.createClientOrderId = options.createClientOrderId ?? randomUUID;
		this.profile = options.profile ?? resolveProfile();
	}

	private blockUnlessA2(): void {
		assertA2Mutation(this.profile);
	}

	private get orders(): OrdersApi {
		return this.ordersApi ?? KalshiClient.getInstance().orders;
	}

	async getOrders(params: GetOrdersParams = {}) {
		const response = await this.orders.getOrders(
			params.ticker,
			params.eventTicker,
			params.minTs,
			params.maxTs,
			params.status,
			params.limit,
			params.cursor,
		);
		return response.data;
	}

	async getOrder(orderId: string) {
		const response = await this.orders.getOrder(orderId);
		return response.data;
	}

	async createOrder(params: CreateOrderParams): Promise<CreateOrderV2Response> {
		this.blockUnlessA2();
		const validated = usesDollarPrices(params)
			? toGridCreateOrder(params)
			: toCreateOrderV2(params);
		const clientOrderId = params.clientOrderId ?? this.createClientOrderId();
		const request = { ...validated, client_order_id: clientOrderId };
		// Exactly one SDK call. An unknown outcome is not retried.
		const response = await this.orders.createOrderV2(request);
		return response.data;
	}

	async cancelOrder(params: CancelOrderParams) {
		this.blockUnlessA2();
		const orderId = requireText(params.orderId, "order id");
		const marketTicker = requireMarketTicker(params.marketTicker);
		const response = await this.orders.cancelOrderV2(
			orderId,
			undefined,
			-1,
			marketTicker,
		);
		return response.data;
	}

	async amendOrder(_params: AmendOrderParams): Promise<never> {
		this.blockUnlessA2();
		throw new OrderMutationClosedError(
			"AMEND_ORDER is fail-closed. V1 amendOrder was removed. V2 count is the filled-plus-resting total, and a wrong mapping can increase size or lose queue position. No amend tool is exposed.",
		);
	}

	async decreaseOrder(params: DecreaseOrderParams) {
		this.blockUnlessA2();
		const orderId = requireText(params.orderId, "order id");
		const marketTicker = requireMarketTicker(params.marketTicker);
		const reduceBy = requireWholeCount(params.reduceBy, "reduceBy");
		const response = await this.orders.decreaseOrderV2(orderId, {
			reduce_by: reduceBy.toFixed(2),
			market_ticker: marketTicker,
			exchange_index: -1,
		});
		return response.data;
	}

	async batchCreateOrders(_params: BatchCreateOrdersParams): Promise<never> {
		this.blockUnlessA2();
		throw new OrderMutationClosedError(
			"BATCH_CREATE_ORDERS is fail-closed. It is not an exposed tool. CREATE_ORDER submits exactly one order and does not retry.",
		);
	}

	async batchCancelOrders(params: BatchCancelOrdersParams) {
		this.blockUnlessA2();
		if (!params.orders?.length) {
			throw new Error(
				params.ids?.length
					? `${SHARD_DEFAULT_REFUSAL} Pass orders with orderId and marketTicker instead of ids alone.`
					: "At least one order is required",
			);
		}
		if (params.orders.length > 20) {
			throw new Error("Batch cancel accepts at most 20 orders");
		}
		const orders = params.orders.map((order) => ({
			order_id: requireText(order.orderId, "order id"),
			market_ticker: requireMarketTicker(order.marketTicker),
			exchange_index: -1 as const,
		}));
		const response = await this.orders.batchCancelOrdersV2({ orders });
		return response.data;
	}

	async getOrderQueuePosition(orderId: string) {
		const response = await this.orders.getOrderQueuePosition(orderId);
		return response.data;
	}

	async getOrderQueuePositions(params: GetOrderQueuePositionsParams = {}) {
		const response = await this.orders.getOrderQueuePositions(
			params.marketTickers,
			params.eventTicker,
		);
		return response.data;
	}
}
