import { ceilDiv, formatMoney, parseCount, parseMoney } from "../lib/fixed.js";

/**
 * Reservation bounds from the July 7, 2026 Kalshi fee schedule and the
 * fee-rounding note. Taker model is 0.07 × multiplier × C × P × (1−P).
 * Maker is 0.25 of that (0.0175); combo maker is 0.5 of taker. Reservations
 * use the taker amount so a make-or-take fill cannot exceed the hold.
 * Flat fee series cannot be derived from the multiplier and must halt.
 *
 * This is a conservative hold, not the exchange's exact invoice. Confirmed
 * fills book the reported fee string.
 */

export type KnownFeeType =
	| "quadratic"
	| "quadratic_with_maker_fees"
	| "quadratic_with_combo_maker_fees";

export type BalancePrecision = "0.01" | "0.0001";

const RATE_NUMERATOR = 7n;
const RATE_DENOMINATOR = 100n;
const SCALE_DIVISOR = 10n ** 14n;

export function assertQuadraticFeeType(feeType: string): KnownFeeType {
	if (
		feeType === "quadratic" ||
		feeType === "quadratic_with_maker_fees" ||
		feeType === "quadratic_with_combo_maker_fees"
	) {
		return feeType;
	}
	throw new Error(
		`Fee type ${feeType} is not a known quadratic schedule. Refusing to guess a flat or custom fee.`,
	);
}

/** Exact model fee at scale 6, truncated only when the rational is not integral. */
export function modelTakerFeeUnits(
	count: string,
	price: string,
	multiplier: string,
): bigint {
	const contracts = parseCount(count);
	const px = parseMoney(price);
	const one = parseMoney("1.000000");
	const mult = parseMoney(multiplier);
	if (contracts <= 0n || px <= 0n || px >= one || mult < 0n) {
		throw new Error(
			"Fee inputs must be a positive count and a price inside (0, 1).",
		);
	}
	const numerator = px * (one - px) * contracts * mult * RATE_NUMERATOR;
	return numerator / (RATE_DENOMINATOR * SCALE_DIVISOR);
}

export function ceilCent(units: bigint): bigint {
	const cent = parseMoney("0.010000");
	return ceilDiv(units, cent) * cent;
}

export function reservationFeeUnits(
	count: string,
	price: string,
	multiplier: string,
	precision: BalancePrecision,
): bigint {
	const model = modelTakerFeeUnits(count, price, multiplier);
	const tableFee = ceilCent(model);
	const slack = parseMoney(precision === "0.01" ? "0.010000" : "0.000100");
	const withSlack = model + slack;
	return withSlack > tableFee ? withSlack : tableFee;
}

export interface ReservationQuote {
	notional: string;
	entryFee: string;
	exitFee: string;
	total: string;
}

export function quoteBuyReservation(input: {
	count: string;
	price: string;
	multiplier: string;
	precision: BalancePrecision;
	feeType: string;
}): ReservationQuote {
	assertQuadraticFeeType(input.feeType);
	const notional = (parseMoney(input.price) * parseCount(input.count)) / 100n;
	const entryFee = reservationFeeUnits(
		input.count,
		input.price,
		input.multiplier,
		input.precision,
	);
	const exitFee = reservationFeeUnits(
		input.count,
		"0.500000",
		input.multiplier,
		input.precision,
	);
	return {
		notional: formatMoney(notional),
		entryFee: formatMoney(entryFee),
		exitFee: formatMoney(exitFee),
		total: formatMoney(notional + entryFee + exitFee),
	};
}

/**
 * Official worked example: revenue −$0.055000, model fee $0.00363825,
 * non-direct cent alignment. Returns the rounding fee $0.001361.
 */
export function roundingFeeExample(): {
	tradeFee: string;
	alignedChange: string;
	roundingFee: string;
} {
	const revenue = parseMoney("-0.055000");
	const model = 363825n; // $0.00363825 at scale 8
	const tradeFee = ceilDiv(model, 100n); // ceil to scale 6
	const change = revenue - tradeFee;
	const aligned = floorCent(change);
	return {
		tradeFee: formatMoney(tradeFee),
		alignedChange: formatMoney(aligned),
		roundingFee: formatMoney(change - aligned),
	};
}

function floorCent(units: bigint): bigint {
	const cent = parseMoney("0.010000");
	const quotient = units / cent;
	const remainder = units % cent;
	if (remainder === 0n) return units;
	return units >= 0n ? quotient * cent : (quotient - 1n) * cent;
}
