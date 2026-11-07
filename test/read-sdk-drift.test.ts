import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MarketApi, PortfolioApi } from "kalshi-typescript";
import { MarketsService } from "../src/services/markets-service.js";
import { PortfolioService } from "../src/services/portfolio-service.js";
import { createMarketTools } from "../src/tools/markets.js";
import { createPortfolioTools } from "../src/tools/portfolio.js";
import { OFFLINE_BASE, installOfflineTransport } from "./offline-transport.js";

test("package pins kalshi-typescript 3.35.0", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
		dependencies: Record<string, string>;
	};
	assert.equal(pkg.dependencies["kalshi-typescript"], "3.35.0");
});

test("getMarkets keeps close filters off the inserted updated-timestamp arguments", async () => {
	const { calls, http } = installOfflineTransport(async () => ({
		markets: [],
		cursor: "",
	}));
	const service = new MarketsService(
		new MarketApi(undefined, OFFLINE_BASE, http),
	);
	await service.getMarkets({
		maxCloseTs: 1_700_000_000,
		minCloseTs: 1_600_000_000,
		status: "open",
		tickers: "ABC",
	});
	assert.equal(calls.length, 1);
	const url = new URL(calls[0]?.url ?? "");
	assert.equal(url.pathname, "/trade-api/v2/markets");
	assert.equal(url.searchParams.get("max_close_ts"), "1700000000");
	assert.equal(url.searchParams.get("min_close_ts"), "1600000000");
	assert.equal(url.searchParams.get("status"), "open");
	assert.equal(url.searchParams.get("tickers"), "ABC");
	assert.equal(url.searchParams.get("min_updated_ts"), null);
	assert.equal(url.searchParams.get("max_updated_ts"), null);
});

test("getPositions keeps ticker off the inserted settlement status argument", async () => {
	const { calls, http } = installOfflineTransport(async () => ({
		market_positions: [],
		event_positions: [],
	}));
	const service = new PortfolioService(
		new PortfolioApi(undefined, OFFLINE_BASE, http),
	);
	await service.getPositions({
		ticker: "ABC",
		eventTicker: "EVT",
		countFilter: "position",
		limit: 25,
	});
	assert.equal(calls.length, 1);
	const url = new URL(calls[0]?.url ?? "");
	assert.equal(url.pathname, "/trade-api/v2/portfolio/positions");
	assert.equal(url.searchParams.get("ticker"), "ABC");
	assert.equal(url.searchParams.get("event_ticker"), "EVT");
	assert.equal(url.searchParams.get("count_filter"), "position");
	assert.equal(url.searchParams.get("limit"), "25");
	assert.equal(url.searchParams.get("settlement_status"), null);
});

test("market, orderbook, trade, and series text uses dollar and fixed-point fields", async () => {
	const markets = {
		async getMarkets() {
			return {
				markets: [
					{
						ticker: "MKT",
						title: "Sample",
						yes_ask_dollars: "0.5600",
						volume_fp: "10.00",
					},
				],
			};
		},
		async getMarket() {
			return {
				market: {
					ticker: "MKT",
					title: "Sample",
					status: "open",
					yes_ask_dollars: "0.5600",
					yes_bid_dollars: "0.5400",
					no_ask_dollars: "0.4600",
					no_bid_dollars: "0.4400",
					volume_fp: "10.00",
					open_interest_fp: "4.00",
					last_price_dollars: "0.550000",
					event_ticker: "EVT",
					close_time: "2026-12-01T00:00:00Z",
					result: "",
				},
			};
		},
		async getMarketOrderbook() {
			return {
				orderbook_fp: {
					yes_dollars: [["0.4500", "3.00"]],
					no_dollars: [["0.5200", "1.50"]],
				},
			};
		},
		async getTrades() {
			return {
				trades: [
					{
						ticker: "MKT",
						count_fp: "2.50",
						yes_price_dollars: "0.4500",
						created_time: "2026-06-01T00:00:00Z",
					},
				],
			};
		},
		async getSeries() {
			return {
				series: {
					ticker: "INXD",
					title: "Index",
					category: "Financials",
					settlement_sources: [
						{ name: "BLS", url: "https://example.invalid/bls" },
					],
				},
			};
		},
	};
	const tools = createMarketTools(markets as never);
	const byName = (name: string) => {
		const found = tools.find((tool) => tool.name === name);
		assert.ok(found);
		return found;
	};
	const listed = await byName("GET_MARKETS").execute({});
	const detail = await byName("GET_MARKET").execute({ ticker: "MKT" });
	const book = await byName("GET_MARKET_ORDERBOOK").execute({ ticker: "MKT" });
	const trades = await byName("GET_TRADES").execute({});
	const series = await byName("GET_SERIES").execute({ seriesTicker: "INXD" });
	assert.match(listed, /Yes ask: \$0\.5600/);
	assert.match(listed, /Volume: 10\.00 contracts/);
	assert.doesNotMatch(listed, /¢/);
	assert.match(detail, /Yes Ask: \$0\.5600/);
	assert.match(detail, /Last Price: \$0\.550000/);
	assert.match(detail, /Open Interest: 4\.00/);
	assert.doesNotMatch(detail, /¢/);
	assert.match(book, /\$0\.4500: 3\.00 contracts/);
	assert.match(book, /\$0\.5200: 1\.50 contracts/);
	assert.doesNotMatch(book, /¢/);
	assert.match(trades, /2\.50 @ \$0\.4500/);
	assert.doesNotMatch(trades, /¢/);
	assert.match(series, /BLS \(https:\/\/example\.invalid\/bls\)/);
	assert.doesNotMatch(series, /\[object Object\]/);
});

test("portfolio text keeps cent balances in dollars and does not divide fixed-point PnL", async () => {
	const portfolio = {
		async getBalance() {
			return {
				balance: 250,
				portfolio_value: 125,
				balance_dollars: "2.500000",
			};
		},
		async getPositions() {
			return {
				market_positions: [
					{
						ticker: "MKT",
						position_fp: "4.00",
						realized_pnl_dollars: "12.340000",
					},
				],
			};
		},
		async getFills() {
			return {
				fills: [
					{
						ticker: "MKT",
						book_side: "ask",
						outcome_side: "no",
						count_fp: "2.00",
						yes_price_dollars: "0.1300",
						created_time: "2026-06-01T00:00:00Z",
					},
				],
			};
		},
		async getSettlements() {
			return {
				settlements: [
					{
						ticker: "MKT",
						market_result: "yes",
						revenue: 250,
						settled_time: "2026-06-01T00:00:00Z",
					},
				],
			};
		},
	};
	const tools = createPortfolioTools(portfolio as never);
	const byName = (name: string) => {
		const found = tools.find((tool) => tool.name === name);
		assert.ok(found);
		return found;
	};
	const balance = await byName("GET_BALANCE").execute({});
	const positions = await byName("GET_POSITIONS").execute({});
	const fills = await byName("GET_FILLS").execute({});
	const settlements = await byName("GET_SETTLEMENTS").execute({});
	assert.match(balance, /Account Balance: \$2\.50/);
	assert.match(balance, /Portfolio Value: \$1\.25/);
	assert.match(balance, /Total: \$3\.75/);
	assert.doesNotMatch(balance, /\$0\.03/);
	assert.match(positions, /4\.00 contracts/);
	assert.match(positions, /Realized P&L: \$12\.340000/);
	assert.doesNotMatch(positions, /\$0\.12/);
	assert.match(fills, /book ask \/ outcome no 2\.00 @ \$0\.1300/);
	assert.doesNotMatch(fills, /¢/);
	assert.match(settlements, /Revenue: \$2\.50/);
});
