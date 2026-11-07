import type { CreateOrderV2Request } from "kalshi-typescript";
import { formatMoney, parseMoney } from "../lib/fixed.js";
import {
	type LegacyCreateInput,
	yesBookSide,
} from "../services/create-order-v2-adapter.js";

export interface PriceBand {
	start: string;
	end: string;
	step: string;
}

export interface GridLimitInput extends LegacyCreateInput {
	yesPriceDollars?: string;
	noPriceDollars?: string;
	priceRanges?: PriceBand[];
	priceObservedAt?: string;
	now?: Date;
	maxMetadataAgeMs?: number;
}

const ONE = parseMoney("1.000000");
const DEFAULT_MAX_AGE_MS = 60_000;

export function priceOnGrid(price: string, ranges: PriceBand[]): boolean {
	if (!ranges.length) {
		return false;
	}
	const value = parseMoney(price);
	if (value <= 0n || value >= ONE) {
		return false;
	}
	return ranges.some((band) => {
		const start = parseMoney(band.start);
		const end = parseMoney(band.end);
		const step = parseMoney(band.step);
		if (step <= 0n || value < start || value > end) {
			return false;
		}
		return (value - start) % step === 0n;
	});
}

export function complementDollars(price: string): string {
	return formatMoney(ONE - parseMoney(price));
}

export function assertFreshMetadata(
	observedAt: string | undefined,
	now: Date,
	maxAgeMs = DEFAULT_MAX_AGE_MS,
): void {
	if (!observedAt) {
		throw new Error(
			"Price grid metadata is absent. Refusing to price without price_ranges.",
		);
	}
	const observed = new Date(observedAt);
	if (Number.isNaN(observed.getTime())) {
		throw new Error("Price grid metadata timestamp is invalid.");
	}
	const skew = now.getTime() - observed.getTime();
	if (skew > maxAgeMs || skew < -5_000) {
		throw new Error("Price grid metadata is stale.");
	}
}

/**
 * Dollar-price path. Legacy whole-cent orders do not call this.
 * Both the selected outcome price and its YES-book complement must sit on the grid.
 */
export function toGridCreateOrder(
	input: GridLimitInput,
	now = input.now ?? new Date(),
): CreateOrderV2Request {
	if (input.yesPrice !== undefined || input.noPrice !== undefined) {
		throw new Error(
			"Do not mix legacy cent prices with dollar prices. Omit yesPrice and noPrice.",
		);
	}
	if (!input.priceRanges?.length) {
		throw new Error(
			"Price grid metadata is absent. Refusing to price without price_ranges.",
		);
	}
	assertFreshMetadata(input.priceObservedAt, now, input.maxMetadataAgeMs);
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
	const selected =
		input.side === "yes" ? input.yesPriceDollars : input.noPriceDollars;
	if (!selected) {
		throw new Error("Selected outcome requires an exact dollar limit price.");
	}
	const other =
		input.side === "yes" ? input.noPriceDollars : input.yesPriceDollars;
	const yesPrice =
		input.side === "yes" ? selected : complementDollars(selected);
	if (other !== undefined && complementDollars(other) !== yesPrice) {
		throw new Error("Inconsistent YES/NO dollar limit prices");
	}
	if (!priceOnGrid(selected, input.priceRanges)) {
		throw new Error("Selected price is off the current market grid.");
	}
	if (!priceOnGrid(yesPrice, input.priceRanges)) {
		throw new Error("YES-book complement is off the current market grid.");
	}
	const timeInForce = input.timeInForce ?? "good_till_canceled";
	if (
		timeInForce !== "fill_or_kill" &&
		timeInForce !== "good_till_canceled" &&
		timeInForce !== "immediate_or_cancel"
	) {
		throw new Error("Invalid time_in_force. GTT is not a valid API value.");
	}
	if (input.reduceOnly === true && timeInForce !== "immediate_or_cancel") {
		throw new Error("reduce_only requires immediate_or_cancel");
	}
	if (input.postOnly === true && timeInForce !== "good_till_canceled") {
		throw new Error("post_only requires a resting good_till_canceled order");
	}
	return {
		ticker: input.ticker.trim(),
		side: yesBookSide(input.side, input.action),
		count: input.count.toFixed(2),
		price: formatMoney(parseMoney(yesPrice)),
		time_in_force: timeInForce,
		self_trade_prevention_type: "taker_at_cross",
		...(input.clientOrderId ? { client_order_id: input.clientOrderId } : {}),
		...(input.expirationTs !== undefined
			? { expiration_time: input.expirationTs }
			: {}),
		...(input.postOnly !== undefined ? { post_only: input.postOnly } : {}),
		...(input.reduceOnly !== undefined
			? { reduce_only: input.reduceOnly }
			: {}),
	};
}

function legacyCentsToDollars(cents: number, label: string): string {
	if (!Number.isSafeInteger(cents) || cents < 1 || cents > 99) {
		throw new Error(`${label} must be a whole-cent legacy price from 1 to 99`);
	}
	return formatMoney(BigInt(cents) * 10_000n);
}

/**
 * Shared gate for every a1 price, whether the caller used legacy cents or
 * dollar strings. Missing, stale, and off-grid prices throw before any order
 * exists. Nothing is snapped onto the grid.
 */
export function prepareA1Limit(
	input: GridLimitInput,
	now = input.now ?? new Date(),
): { request: CreateOrderV2Request; paidPrice: string } {
	if (!input.priceRanges?.length) {
		throw new Error(
			"Price grid metadata is absent. Refusing to price without price_ranges.",
		);
	}
	assertFreshMetadata(input.priceObservedAt, now, input.maxMetadataAgeMs);
	const cents = input.side === "yes" ? input.yesPrice : input.noPrice;
	const dollars =
		input.side === "yes" ? input.yesPriceDollars : input.noPriceDollars;
	if (cents !== undefined && dollars !== undefined) {
		throw new Error("Do not mix legacy cent prices with dollar prices.");
	}
	const selected =
		dollars ??
		(cents === undefined
			? undefined
			: legacyCentsToDollars(
					cents,
					input.side === "yes" ? "yesPrice" : "noPrice",
				));
	if (!selected) {
		throw new Error(
			"Selected outcome requires a limit price on the current grid.",
		);
	}
	const request = toGridCreateOrder(
		{
			...input,
			yesPrice: undefined,
			noPrice: undefined,
			yesPriceDollars: input.side === "yes" ? selected : undefined,
			noPriceDollars: input.side === "no" ? selected : undefined,
			now,
		},
		now,
	);
	return { request, paidPrice: formatMoney(parseMoney(selected)) };
}

export function usesDollarPrices(input: {
	yesPriceDollars?: string;
	noPriceDollars?: string;
}): boolean {
	return (
		input.yesPriceDollars !== undefined || input.noPriceDollars !== undefined
	);
}

/** Example tapered grid from the fixed-point docs. Not a universal market grid. */
export const TAPERED_DECI_CENT: PriceBand[] = [
	{ start: "0.000000", end: "0.100000", step: "0.001000" },
	{ start: "0.100000", end: "0.900000", step: "0.010000" },
	{ start: "0.900000", end: "1.000000", step: "0.001000" },
];
