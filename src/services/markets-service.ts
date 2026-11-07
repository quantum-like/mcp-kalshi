import {
	GetMarketCandlesticksPeriodIntervalEnum,
	type GetMarketsStatusEnum,
} from "kalshi-typescript";
import { KalshiClient } from "./kalshi-client.js";

export interface GetMarketsParams {
	limit?: number;
	cursor?: string;
	eventTicker?: string;
	seriesTicker?: string;
	minCreatedTs?: number;
	maxCreatedTs?: number;
	maxCloseTs?: number;
	minCloseTs?: number;
	minSettledTs?: number;
	maxSettledTs?: number;
	status?: GetMarketsStatusEnum;
	tickers?: string;
}

export interface GetMarketOrderbookParams {
	ticker: string;
	depth?: number;
}

export interface GetMarketCandlesticksParams {
	seriesTicker: string;
	marketTicker: string;
	startTs: number;
	endTs: number;
	periodInterval: 1 | 60 | 1440;
}

export interface GetTradesParams {
	limit?: number;
	cursor?: string;
	ticker?: string;
	minTs?: number;
	maxTs?: number;
}

export { GetMarketCandlesticksPeriodIntervalEnum };

export class MarketsService {
	constructor(private readonly marketApi?: KalshiClient["market"]) {}

	private get market(): KalshiClient["market"] {
		return this.marketApi ?? KalshiClient.getInstance().market;
	}

	async getMarkets(params: GetMarketsParams = {}) {
		// SDK 3.35 inserted minUpdatedTs and maxUpdatedTs before the close filters.
		// Passing undefined keeps maxCloseTs on max_close_ts instead of min_updated_ts.
		const response = await this.market.getMarkets(
			params.limit,
			params.cursor,
			params.eventTicker,
			params.seriesTicker,
			params.minCreatedTs,
			params.maxCreatedTs,
			undefined,
			undefined,
			params.maxCloseTs,
			params.minCloseTs,
			params.minSettledTs,
			params.maxSettledTs,
			params.status,
			params.tickers,
		);
		return response.data;
	}

	async getMarket(ticker: string) {
		const response = await this.market.getMarket(ticker);
		return response.data;
	}

	async getMarketOrderbook(params: GetMarketOrderbookParams) {
		const response = await this.market.getMarketOrderbook(
			params.ticker,
			params.depth,
		);
		return response.data;
	}

	async getMarketCandlesticks(params: GetMarketCandlesticksParams) {
		const response = await this.market.getMarketCandlesticks(
			params.seriesTicker,
			params.marketTicker,
			params.startTs,
			params.endTs,
			params.periodInterval,
		);
		return response.data;
	}

	async getTrades(params: GetTradesParams = {}) {
		const response = await this.market.getTrades(
			params.limit,
			params.cursor,
			params.ticker,
			params.minTs,
			params.maxTs,
		);
		return response.data;
	}

	async getSeries(seriesTicker: string) {
		const response = await this.market.getSeries(seriesTicker);
		return response.data;
	}

	async getSeriesList(category?: string, tags?: string) {
		const response = await this.market.getSeriesList(category, tags);
		return response.data;
	}
}
