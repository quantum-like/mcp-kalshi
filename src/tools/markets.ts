import dedent from "dedent";
import { z } from "zod";
import { MarketsService } from "../services/markets-service.js";

function dollar(value: string | undefined): string {
	return value ? `$${value}` : "not returned";
}

function contracts(value: string | undefined): string {
	return value ?? "not returned";
}

export function createMarketTools(marketsService = new MarketsService()) {
	// GET_MARKETS tool
	const getMarketsParams = z.object({
		limit: z
			.number()
			.min(1)
			.max(1000)
			.optional()
			.describe("Number of results per page (1-1000, default 100)"),
		cursor: z
			.string()
			.optional()
			.describe("Pagination cursor from previous response"),
		eventTicker: z
			.string()
			.optional()
			.describe("Filter by event ticker (comma-separated, max 10)"),
		seriesTicker: z.string().optional().describe("Filter by series ticker"),
		status: z
			.enum(["unopened", "open", "paused", "closed", "settled"])
			.optional()
			.describe("Filter by market status"),
		tickers: z
			.string()
			.optional()
			.describe("Filter by specific market tickers (comma-separated)"),
	});

	const getMarketsTool = {
		name: "GET_MARKETS",
		description:
			"List and discover prediction markets on Kalshi. Markets represent binary outcomes users can trade on. Returns paginated results with market details including ticker, title, prices, and volume.",
		parameters: getMarketsParams,
		execute: async (params: z.infer<typeof getMarketsParams>) => {
			try {
				const result = await marketsService.getMarkets(params);
				const markets = result.markets || [];
				if (markets.length === 0) {
					return "No markets found matching the criteria.";
				}
				const summary = markets
					.map((m) => {
						return `• ${m.ticker}: ${m.title} (Yes ask: ${dollar(m.yes_ask_dollars)}, Volume: ${contracts(m.volume_fp)} contracts)`;
					})
					.join("\n");
				return dedent`
				Found ${markets.length} markets${result.cursor ? ` (more available with cursor: ${result.cursor})` : ""}:

				${summary}
			`;
			} catch (error) {
				return `Error fetching markets: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	// GET_MARKET tool
	const getMarketParams = z.object({
		ticker: z
			.string()
			.min(1)
			.describe("The market ticker (e.g., 'INXD-25JAN20')"),
	});

	const getMarketTool = {
		name: "GET_MARKET",
		description:
			"Get detailed information about a specific prediction market by its ticker, including current prices, volume, open interest, and settlement rules.",
		parameters: getMarketParams,
		execute: async (params: z.infer<typeof getMarketParams>) => {
			try {
				const result = await marketsService.getMarket(params.ticker);
				const m = result.market;
				if (!m) {
					return `Market with ticker '${params.ticker}' not found.`;
				}
				return dedent`
				Market: ${m.ticker}
				Title: ${m.title}
				Status: ${m.status}

				Pricing (fixed-point dollars, not cents):
				• Yes Ask: ${dollar(m.yes_ask_dollars)} | Yes Bid: ${dollar(m.yes_bid_dollars)}
				• No Ask: ${dollar(m.no_ask_dollars)} | No Bid: ${dollar(m.no_bid_dollars)}

				Activity (fixed-point contract counts):
				• Volume: ${contracts(m.volume_fp)}
				• Open Interest: ${contracts(m.open_interest_fp)}
				• Last Price: ${dollar(m.last_price_dollars)}

				Event: ${m.event_ticker}
				Close Time: ${m.close_time}
				${m.result ? `Result: ${m.result}` : ""}
			`;
			} catch (error) {
				return `Error fetching market: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	// GET_MARKET_ORDERBOOK tool
	const getOrderbookParams = z.object({
		ticker: z.string().min(1).describe("The market ticker"),
		depth: z
			.number()
			.min(1)
			.max(100)
			.optional()
			.describe("Depth of orderbook to retrieve (1-100, default 10)"),
	});

	const getMarketOrderbookTool = {
		name: "GET_MARKET_ORDERBOOK",
		description:
			"Get the current orderbook for a market showing bid prices and quantities for both Yes and No sides.",
		parameters: getOrderbookParams,
		execute: async (params: z.infer<typeof getOrderbookParams>) => {
			try {
				const result = await marketsService.getMarketOrderbook(params);
				const ob = result.orderbook_fp;
				if (!ob) {
					return `No orderbook data for ticker '${params.ticker}'.`;
				}

				const formatSide = (
					levels: Array<Array<string>> | undefined,
					name: string,
				) => {
					if (!levels || levels.length === 0) return `${name}: No orders`;
					return `${name}:\n${levels
						.map((level) => {
							const price = level[0] ?? "not returned";
							const quantity = level[1] ?? "not returned";
							return `  $${price}: ${quantity} contracts`;
						})
						.join("\n")}`;
				};

				return dedent`
				Orderbook for ${params.ticker} (dollar prices and fixed-point contract counts):

				${formatSide(ob.yes_dollars, "YES bids")}

				${formatSide(ob.no_dollars, "NO bids")}
			`;
			} catch (error) {
				return `Error fetching orderbook: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	// GET_TRADES tool
	const getTradesParams = z.object({
		ticker: z.string().optional().describe("Filter by market ticker"),
		limit: z
			.number()
			.min(1)
			.max(1000)
			.optional()
			.describe("Number of results (1-1000, default 100)"),
		cursor: z.string().optional().describe("Pagination cursor"),
		minTs: z
			.number()
			.optional()
			.describe("Filter trades after this Unix timestamp"),
		maxTs: z
			.number()
			.optional()
			.describe("Filter trades before this Unix timestamp"),
	});

	const getTradesTool = {
		name: "GET_TRADES",
		description:
			"Get recent public trades across all markets or for a specific market. Each trade shows price, quantity, and timestamp.",
		parameters: getTradesParams,
		execute: async (params: z.infer<typeof getTradesParams>) => {
			try {
				const result = await marketsService.getTrades(params);
				const trades = result.trades || [];
				if (trades.length === 0) {
					return "No trades found.";
				}
				const summary = trades
					.map((t) => {
						const time = t.created_time
							? new Date(t.created_time).toLocaleString()
							: "N/A";
						return `• ${t.ticker}: ${contracts(t.count_fp)} @ ${dollar(t.yes_price_dollars)} (${time})`;
					})
					.join("\n");
				return dedent`
				Found ${trades.length} trades:

				${summary}
			`;
			} catch (error) {
				return `Error fetching trades: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	// GET_SERIES tool
	const getSeriesParams = z.object({
		seriesTicker: z
			.string()
			.min(1)
			.describe("The series ticker (e.g., 'INXD' for S&P 500)"),
	});

	const getSeriesTool = {
		name: "GET_SERIES",
		description:
			"Get information about a series, which is a template for recurring events (e.g., monthly jobs reports, daily weather).",
		parameters: getSeriesParams,
		execute: async (params: z.infer<typeof getSeriesParams>) => {
			try {
				const result = await marketsService.getSeries(params.seriesTicker);
				const s = result.series;
				if (!s) {
					return `Series '${params.seriesTicker}' not found.`;
				}
				return dedent`
				Series: ${s.ticker}
				Title: ${s.title}
				Category: ${s.category}

				${
					s.settlement_sources?.length
						? `Settlement Sources: ${s.settlement_sources
								.map((source) =>
									source.url
										? `${source.name ?? "source"} (${source.url})`
										: (source.name ?? "source"),
								)
								.join(", ")}`
						: ""
				}
			`;
			} catch (error) {
				return `Error fetching series: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	return [
		getMarketsTool,
		getMarketTool,
		getMarketOrderbookTool,
		getTradesTool,
		getSeriesTool,
	] as const;
}

export const marketTools = createMarketTools();
