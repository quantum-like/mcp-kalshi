import { formatPacific } from "../lib/pst.js";
import type { ReadPage } from "./paginate.js";

export function shownDecimal(
	value: string | number | null | undefined,
	unit: string,
): string {
	if (value === undefined || value === null || value === "") {
		return `UNKNOWN ${unit}`;
	}
	return `${value} ${unit}`;
}

export function renderRead<T>(
	title: string,
	page: ReadPage<T>,
	lines: string[],
	structured: unknown,
): string {
	const header = [
		title,
		`status: ${page.status}`,
		`terminal: ${page.terminal}`,
		`cursor: ${page.cursor ?? "none"}`,
		`watermark: ${page.watermark ?? "none"}`,
		`pages: ${page.pages}`,
		page.reason ? `reason: ${page.reason}` : "",
		`items: ${page.items.length}`,
	].filter(Boolean);
	return `${header.join("\n")}\n${lines.join("\n")}\n--- json ---\n${JSON.stringify(structured)}`;
}

export function stamp(value: string | number | null | undefined): string {
	const pacific = formatPacific(value);
	return `${pacific.original} | ${pacific.pacific}`;
}

export interface PositionView {
	ticker: string;
	position_fp: string;
	market_exposure_dollars: string;
	total_traded_dollars: string;
	realized_pnl_dollars: string;
	fees_paid_dollars: string;
	exchange_index: string;
	netting: string;
	subaccount: string;
	last_updated: string;
}

export function viewPosition(position: Record<string, unknown>): PositionView {
	const extra = position as {
		netting_enabled?: unknown;
		subaccount?: unknown;
		subaccount_number?: unknown;
	};
	return {
		ticker: text(position.ticker),
		position_fp: decimal(position.position_fp, "contracts"),
		market_exposure_dollars: decimal(
			position.market_exposure_dollars,
			"dollars",
		),
		total_traded_dollars: decimal(position.total_traded_dollars, "dollars"),
		realized_pnl_dollars: decimal(position.realized_pnl_dollars, "dollars"),
		fees_paid_dollars: decimal(position.fees_paid_dollars, "dollars"),
		exchange_index:
			typeof position.exchange_index === "number"
				? String(position.exchange_index)
				: "UNKNOWN shard",
		netting:
			typeof extra.netting_enabled === "boolean"
				? String(extra.netting_enabled)
				: "UNKNOWN",
		subaccount:
			extra.subaccount !== undefined
				? String(extra.subaccount)
				: extra.subaccount_number !== undefined
					? String(extra.subaccount_number)
					: "UNKNOWN",
		last_updated: stamp(
			typeof position.last_updated_ts === "string"
				? position.last_updated_ts
				: undefined,
		),
	};
}

export function viewBalance(balance: Record<string, unknown>): {
	balance_dollars: string;
	balance_cents: string;
	portfolio_value_cents: string;
	updated: string;
} {
	return {
		balance_dollars: decimal(balance.balance_dollars, "dollars"),
		balance_cents:
			typeof balance.balance === "number"
				? `${balance.balance} cents (integer field, not the accounting figure)`
				: "UNKNOWN cents",
		portfolio_value_cents:
			typeof balance.portfolio_value === "number"
				? `${balance.portfolio_value} cents (integer field)`
				: "UNKNOWN cents",
		updated: stamp(
			typeof balance.updated_ts === "number" ? balance.updated_ts : undefined,
		),
	};
}

function decimal(value: unknown, unit: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		return `UNKNOWN ${unit}`;
	}
	return `${value} ${unit}`;
}

function text(value: unknown): string {
	return typeof value === "string" && value.trim() !== "" ? value : "UNKNOWN";
}
