import type { OrdersService } from "../services/orders-service.js";
import type { PortfolioService } from "../services/portfolio-service.js";
import { viewBalance, viewPosition } from "./format.js";
import { type ReadPage, paginateReads } from "./paginate.js";

const ORDER_LIMIT = 200;
const FILL_LIMIT = 200;
const SETTLEMENT_LIMIT = 200;
const POSITION_LIMIT = 1000;

export interface PositionPage {
	market_positions?: Array<Record<string, unknown>>;
	event_positions?: Array<Record<string, unknown>>;
	cursor?: string;
}

export interface ListPage {
	orders?: Array<Record<string, unknown>>;
	fills?: Array<Record<string, unknown>>;
	settlements?: Array<Record<string, unknown>>;
	cursor?: string;
}

export class AccountReadService {
	constructor(
		private readonly portfolio: Pick<
			PortfolioService,
			"getBalance" | "getPositions" | "getFills" | "getSettlements"
		>,
		private readonly orders: Pick<OrdersService, "getOrders">,
	) {}

	async readBalance(): Promise<ReturnType<typeof viewBalance>> {
		const data = await this.portfolio.getBalance();
		return viewBalance(data as unknown as Record<string, unknown>);
	}

	async readPositions(params: {
		ticker?: string;
		eventTicker?: string;
		countFilter?: string;
		limit?: number;
		cursor?: string;
		maxPages?: number;
	}): Promise<ReadPage<ReturnType<typeof viewPosition>>> {
		const limit = cap(params.limit, POSITION_LIMIT);
		const page = await paginateReads<ReturnType<typeof viewPosition>>({
			maxPages: params.maxPages,
			identity: (item) =>
				`${item.ticker}:${item.exchange_index}:${item.position_fp}`,
			fetchPage: async (cursor) => {
				const data = (await this.portfolio.getPositions({
					ticker: params.ticker,
					eventTicker: params.eventTicker,
					countFilter: params.countFilter,
					limit,
					cursor: cursor ?? params.cursor,
				})) as unknown as PositionPage;
				if (!Array.isArray(data.market_positions)) {
					throw new Error("market_positions is absent");
				}
				return {
					items: data.market_positions.map((position) =>
						viewPosition(position),
					),
					cursor: data.cursor ? data.cursor : null,
				};
			},
		});
		return page;
	}

	async readOrders(params: {
		ticker?: string;
		minTs?: number;
		maxTs?: number;
		status?: string;
		limit?: number;
		cursor?: string;
		maxPages?: number;
	}): Promise<ReadPage<Record<string, unknown>>> {
		const limit = cap(params.limit, ORDER_LIMIT);
		return paginateReads({
			maxPages: params.maxPages,
			identity: (order) => String(order.order_id ?? ""),
			fetchPage: async (cursor) => {
				const data = (await this.orders.getOrders({
					ticker: params.ticker,
					minTs: params.minTs,
					maxTs: params.maxTs,
					status: params.status,
					limit,
					cursor: cursor ?? params.cursor,
				})) as unknown as ListPage;
				if (!Array.isArray(data.orders)) {
					throw new Error("orders is absent");
				}
				return {
					items: data.orders,
					cursor: data.cursor ? data.cursor : null,
				};
			},
		});
	}

	async readFills(params: {
		ticker?: string;
		orderId?: string;
		minTs?: number;
		maxTs?: number;
		limit?: number;
		cursor?: string;
		maxPages?: number;
	}): Promise<ReadPage<Record<string, unknown>>> {
		const limit = cap(params.limit, FILL_LIMIT);
		return paginateReads({
			maxPages: params.maxPages,
			identity: (fill) => String(fill.fill_id ?? ""),
			fetchPage: async (cursor) => {
				const data = (await this.portfolio.getFills({
					ticker: params.ticker,
					orderId: params.orderId,
					minTs: params.minTs,
					maxTs: params.maxTs,
					limit,
					cursor: cursor ?? params.cursor,
				})) as unknown as ListPage;
				if (!Array.isArray(data.fills)) {
					throw new Error("fills is absent");
				}
				return {
					items: data.fills,
					cursor: data.cursor ? data.cursor : null,
				};
			},
		});
	}

	async readSettlements(params: {
		ticker?: string;
		minTs?: number;
		maxTs?: number;
		limit?: number;
		cursor?: string;
		maxPages?: number;
	}): Promise<ReadPage<Record<string, unknown>>> {
		const limit = cap(params.limit, SETTLEMENT_LIMIT);
		return paginateReads({
			maxPages: params.maxPages,
			identity: (settlement) =>
				[
					settlement.ticker,
					settlement.settled_time,
					settlement.exchange_index,
					settlement.revenue,
				].join(":"),
			fetchPage: async (cursor) => {
				const data = (await this.portfolio.getSettlements({
					ticker: params.ticker,
					minTs: params.minTs,
					maxTs: params.maxTs,
					limit,
					cursor: cursor ?? params.cursor,
				})) as unknown as ListPage;
				if (!Array.isArray(data.settlements)) {
					throw new Error("settlements is absent");
				}
				return {
					items: data.settlements,
					cursor: data.cursor ? data.cursor : null,
				};
			},
		});
	}
}

function cap(limit: number | undefined, maximum: number): number {
	if (limit === undefined) return Math.min(100, maximum);
	if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
		throw new Error(`limit must be an integer from 1 to ${maximum}`);
	}
	return limit;
}
