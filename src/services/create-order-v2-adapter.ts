import type { CreateOrderV2Request } from "kalshi-typescript";

export interface LegacyCreateInput {
	ticker: string;
	side: "yes" | "no";
	action: "buy" | "sell";
	count: number;
	type?: "limit" | "market";
	yesPrice?: number;
	noPrice?: number;
	clientOrderId?: string;
	expirationTs?: number;
	timeInForce?: "fill_or_kill" | "good_till_canceled" | "immediate_or_cancel";
	postOnly?: boolean;
	reduceOnly?: boolean;
}

const TIME_IN_FORCE = [
	"fill_or_kill",
	"good_till_canceled",
	"immediate_or_cancel",
] as const;

type TimeInForce = (typeof TIME_IN_FORCE)[number];

function isTimeInForce(value: string): value is TimeInForce {
	return (TIME_IN_FORCE as readonly string[]).includes(value);
}

function wholeCents(
	value: number | undefined,
	label: string,
): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isInteger(value) || value < 1 || value > 99) {
		throw new Error(`${label} must be a whole-cent limit price from 1 to 99`);
	}
	return value;
}

/**
 * Buy YES and sell NO rest on the YES bid. Sell YES and buy NO rest on the YES ask.
 * NO prices are complemented onto the YES book before the dollar conversion.
 * Official book: bid buys YES, ask sells YES.
 */
export function yesBookSide(
	side: "yes" | "no",
	action: "buy" | "sell",
): "bid" | "ask" {
	const buyYes = side === "yes" && action === "buy";
	const sellNo = side === "no" && action === "sell";
	return buyYes || sellNo ? "bid" : "ask";
}

/**
 * Pure translation from the legacy YES/NO buy/sell tool input to Create Order V2.
 * No client, credentials, retries, or network access.
 */
export function toCreateOrderV2(
	input: LegacyCreateInput,
): CreateOrderV2Request {
	if (typeof input.ticker !== "string" || input.ticker.trim() === "") {
		throw new Error("ticker is required");
	}
	if (input.side !== "yes" && input.side !== "no") {
		throw new Error("side must be yes or no");
	}
	if (input.action !== "buy" && input.action !== "sell") {
		throw new Error("action must be buy or sell");
	}
	if ((input.type ?? "limit") !== "limit") {
		throw new Error(
			"Market orders are disabled. Submit an explicit limit price.",
		);
	}
	if (
		typeof input.count !== "number" ||
		!Number.isSafeInteger(input.count) ||
		input.count < 1
	) {
		throw new Error("Whole positive contract count required");
	}
	if (
		input.clientOrderId !== undefined &&
		(typeof input.clientOrderId !== "string" ||
			input.clientOrderId.trim() === "")
	) {
		throw new Error("client_order_id must be a non-empty string when provided");
	}

	const yesPrice = wholeCents(input.yesPrice, "yesPrice");
	const noPrice = wholeCents(input.noPrice, "noPrice");
	if (
		yesPrice !== undefined &&
		noPrice !== undefined &&
		yesPrice + noPrice !== 100
	) {
		throw new Error("Inconsistent YES/NO limit prices");
	}
	const selected = input.side === "yes" ? yesPrice : noPrice;
	if (selected === undefined) {
		throw new Error(
			"Selected outcome requires a whole-cent limit price from 1 to 99",
		);
	}

	const timeInForce = input.timeInForce ?? "good_till_canceled";
	if (!isTimeInForce(timeInForce)) {
		throw new Error("Invalid time_in_force. GTT is not a valid API value.");
	}
	if (input.reduceOnly === true && timeInForce !== "immediate_or_cancel") {
		throw new Error("reduce_only requires immediate_or_cancel");
	}
	if (input.postOnly === true && timeInForce !== "good_till_canceled") {
		throw new Error("post_only requires a resting good_till_canceled order");
	}
	if (
		input.expirationTs !== undefined &&
		(timeInForce !== "good_till_canceled" ||
			!Number.isSafeInteger(input.expirationTs) ||
			input.expirationTs <= 0)
	) {
		throw new Error(
			"expiration_time requires a positive integer Unix second timestamp and good_till_canceled",
		);
	}

	const yesCents = input.side === "yes" ? selected : 100 - selected;
	const request: CreateOrderV2Request = {
		ticker: input.ticker.trim(),
		side: yesBookSide(input.side, input.action),
		count: input.count.toFixed(2),
		price: (yesCents / 100).toFixed(4),
		time_in_force: timeInForce,
		// Cancel the incoming order on a self-cross. Do not cancel the resting order.
		self_trade_prevention_type: "taker_at_cross",
	};
	if (input.clientOrderId !== undefined) {
		request.client_order_id = input.clientOrderId;
	}
	if (input.expirationTs !== undefined) {
		request.expiration_time = input.expirationTs;
	}
	if (input.postOnly !== undefined) {
		request.post_only = input.postOnly;
	}
	if (input.reduceOnly !== undefined) {
		request.reduce_only = input.reduceOnly;
	}
	return request;
}
