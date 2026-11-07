import { z } from "zod";
import { DATA_GUARD_DEFAULTS } from "../data-guard/sealed-window.js";
import { AccountReadService } from "../reads/account-read-service.js";
import { renderRead, type viewPosition } from "../reads/format.js";
import type { ReadPage } from "../reads/paginate.js";
import { OrdersService } from "../services/orders-service.js";
import { PortfolioService } from "../services/portfolio-service.js";
import { ENFORCEMENT_BOUNDARY } from "../strategy/boundary.js";
import { StrategyLedger } from "../strategy/ledger.js";

const limit = z.number().int().min(1).optional();

export function createA1Tools(
	reads = new AccountReadService(new PortfolioService(), new OrdersService()),
	ledgerDirectory = process.env.KALSHI_A1_LEDGER_DIR,
) {
	const readBalanceTool = {
		name: "READ_BALANCE",
		description:
			"Structured account balance. balance_dollars is the fixed-point figure. The integer cent fields are labeled separately and are not treated as zero when absent.",
		parameters: z.object({}),
		execute: async () => {
			try {
				const view = await reads.readBalance();
				return [
					"READ_BALANCE",
					`balance_dollars: ${view.balance_dollars}`,
					`balance_cents: ${view.balance_cents}`,
					`portfolio_value_cents: ${view.portfolio_value_cents}`,
					`updated: ${view.updated}`,
					"--- json ---",
					JSON.stringify(view),
				].join("\n");
			} catch (error) {
				return `Error reading balance: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	const pageParams = {
		ticker: z.string().optional(),
		limit,
		cursor: z.string().optional(),
		maxPages: z.number().int().min(1).max(20).optional(),
	};

	const readPositionsTool = {
		name: "READ_POSITIONS",
		description:
			"Paginated positions with signed position_fp, dollar exposure, fees, P&L, shard, and a completeness cursor. Missing numbers are UNKNOWN, not zero. Does not pass the ticker as settlementStatus.",
		parameters: z.object({
			...pageParams,
			eventTicker: z.string().optional(),
			countFilter: z.string().optional(),
		}),
		execute: async (params: {
			ticker?: string;
			eventTicker?: string;
			countFilter?: string;
			limit?: number;
			cursor?: string;
			maxPages?: number;
		}) => {
			try {
				const page = await reads.readPositions(params);
				return renderPositions(page);
			} catch (error) {
				return `Error reading positions: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	const readOrdersTool = {
		name: "READ_ORDERS",
		description:
			"Paginated orders with full order ids, optional time bounds, and completeness. Read failures are not reported as an empty book.",
		parameters: z.object({
			...pageParams,
			minTs: z.number().int().optional(),
			maxTs: z.number().int().optional(),
			status: z.enum(["resting", "canceled", "executed"]).optional(),
		}),
		execute: async (params: {
			ticker?: string;
			minTs?: number;
			maxTs?: number;
			status?: "resting" | "canceled" | "executed";
			limit?: number;
			cursor?: string;
			maxPages?: number;
		}) => {
			try {
				const page = await reads.readOrders(params);
				const lines = page.items.map(
					(order) =>
						`• ${text(order.order_id)} client ${text(order.client_order_id)} ${text(order.ticker)} ${text(order.book_side)}/${text(order.outcome_side)} filled ${text(order.fill_count_fp)} remaining ${text(order.remaining_count_fp)} YES ${text(order.yes_price_dollars)} [${text(order.status)}]`,
				);
				return renderRead("READ_ORDERS", page, lines, page.items);
			} catch (error) {
				return `Error reading orders: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	const readFillsTool = {
		name: "READ_FILLS",
		description:
			"Paginated fills with full fill ids. Same-timestamp fills stay distinct. Missing fees and prices are UNKNOWN.",
		parameters: z.object({
			...pageParams,
			orderId: z.string().optional(),
			minTs: z.number().int().optional(),
			maxTs: z.number().int().optional(),
		}),
		execute: async (params: {
			ticker?: string;
			orderId?: string;
			minTs?: number;
			maxTs?: number;
			limit?: number;
			cursor?: string;
			maxPages?: number;
		}) => {
			try {
				const page = await reads.readFills(params);
				const lines = page.items.map(
					(fill) =>
						`• ${text(fill.fill_id)} order ${text(fill.order_id)} ${text(fill.ticker)} ${text(fill.book_side)}/${text(fill.outcome_side)} ${text(fill.count_fp)} @ YES ${text(fill.yes_price_dollars)} fee ${text(fill.fee_cost)} ${text(fill.created_time)}`,
				);
				return renderRead("READ_FILLS", page, lines, page.items);
			} catch (error) {
				return `Error reading fills: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	const readSettlementsTool = {
		name: "READ_SETTLEMENTS",
		description:
			"Paginated settlements. Revenue cents stay labeled as cents. A failed page is not a flat account.",
		parameters: z.object({
			...pageParams,
			minTs: z.number().int().optional(),
			maxTs: z.number().int().optional(),
		}),
		execute: async (params: {
			ticker?: string;
			minTs?: number;
			maxTs?: number;
			limit?: number;
			cursor?: string;
			maxPages?: number;
		}) => {
			try {
				const page = await reads.readSettlements(params);
				const lines = page.items.map(
					(settlement) =>
						`• ${text(settlement.ticker)} result ${text(settlement.market_result)} revenue_cents ${settlement.revenue === undefined ? "UNKNOWN" : String(settlement.revenue)} ${text(settlement.settled_time)}`,
				);
				return renderRead("READ_SETTLEMENTS", page, lines, page.items);
			} catch (error) {
				return `Error reading settlements: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	} as const;

	const strategyStatusTool = {
		name: "A1_STRATEGY_STATUS",
		description:
			"Reports the disarmed a1 strategy ledger. It does not arm trading, reserve funds, or submit orders. The ledger cannot stop other account callers.",
		parameters: z.object({}),
		execute: async () => {
			if (!ledgerDirectory) {
				return [
					"A1_STRATEGY_STATUS",
					"armed: false",
					"capital: 5.000000",
					"ledger: not configured",
					"historical_mode: 000",
					"historical_days: none",
					ENFORCEMENT_BOUNDARY,
				].join("\n");
			}
			const ledger = new StrategyLedger(ledgerDirectory);
			const state = await ledger.status();
			return [
				"A1_STRATEGY_STATUS",
				`armed: ${state.armed}`,
				`capital: ${state.capital}`,
				`cash: ${state.cash}`,
				`free: ${ledger.freeCash(state)}`,
				`open_intents: ${state.intents.filter((intent) => intent.state === "submitting" || intent.state === "unknown").length}`,
				`historical_mode: ${DATA_GUARD_DEFAULTS.mode}`,
				`historical_days: ${DATA_GUARD_DEFAULTS.historicalDays.join(",") || "none"}`,
				state.enforcement,
			].join("\n");
		},
	} as const;

	return [
		readBalanceTool,
		readPositionsTool,
		readOrdersTool,
		readFillsTool,
		readSettlementsTool,
		strategyStatusTool,
	] as const;
}

export const a1Tools = createA1Tools();

function renderPositions(
	page: ReadPage<ReturnType<typeof viewPosition>>,
): string {
	const lines = page.items.map(
		(position) =>
			`• ${position.ticker} position ${position.position_fp} exposure ${position.market_exposure_dollars} traded ${position.total_traded_dollars} pnl ${position.realized_pnl_dollars} fees ${position.fees_paid_dollars} shard ${position.exchange_index} netting ${position.netting} subaccount ${position.subaccount} ${position.last_updated}`,
	);
	return renderRead("READ_POSITIONS", page, lines, page.items);
}

function text(value: unknown): string {
	if (value === undefined || value === null || value === "") return "UNKNOWN";
	return String(value);
}
