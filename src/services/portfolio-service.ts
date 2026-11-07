import { KalshiClient } from "./kalshi-client.js";

export interface GetFillsParams {
	ticker?: string;
	orderId?: string;
	minTs?: number;
	maxTs?: number;
	limit?: number;
	cursor?: string;
}

export interface GetPositionsParams {
	cursor?: string;
	limit?: number;
	countFilter?: string;
	ticker?: string;
	eventTicker?: string;
}

export interface GetSettlementsParams {
	limit?: number;
	cursor?: string;
	ticker?: string;
	eventTicker?: string;
	minTs?: number;
	maxTs?: number;
}

export class PortfolioService {
	constructor(private readonly portfolioApi?: KalshiClient["portfolio"]) {}

	private get portfolio(): KalshiClient["portfolio"] {
		return this.portfolioApi ?? KalshiClient.getInstance().portfolio;
	}

	async getBalance() {
		const response = await this.portfolio.getBalance();
		return response.data;
	}

	async getPositions(params: GetPositionsParams = {}) {
		// SDK 3.35 inserted settlementStatus before ticker. Leaving it undefined
		// preserves the ticker filter instead of sending the ticker as a status.
		const response = await this.portfolio.getPositions(
			params.cursor,
			params.limit,
			params.countFilter,
			undefined,
			params.ticker,
			params.eventTicker,
		);
		return response.data;
	}

	async getFills(params: GetFillsParams = {}) {
		const response = await this.portfolio.getFills(
			params.ticker,
			params.orderId,
			params.minTs,
			params.maxTs,
			params.limit,
			params.cursor,
		);
		return response.data;
	}

	async getSettlements(params: GetSettlementsParams = {}) {
		const response = await this.portfolio.getSettlements(
			params.limit,
			params.cursor,
			params.ticker,
			params.eventTicker,
			params.minTs,
			params.maxTs,
		);
		return response.data;
	}

	async getRestingOrderTotalValue() {
		const response = await this.portfolio.getPortfolioRestingOrderTotalValue();
		return response.data;
	}
}
