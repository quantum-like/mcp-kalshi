import { randomUUID } from "node:crypto";
import {
	formatCount,
	formatMoney,
	parseCount,
	parseMoney,
} from "../lib/fixed.js";
import {
	type BalancePrecision,
	quoteBuyReservation,
} from "../strategy/fees.js";
import { OlgaRefusal, type Reservation, type ReserveInput } from "./state.js";

export interface OlgaFill {
	fillId: string;
	clientOrderId: string;
	action: "buy" | "sell";
	count: string;
	price: string;
	fee: string;
	cashDelta: string;
}

export function positiveCount(input: string): bigint {
	let units: bigint;
	try {
		units = parseCount(input);
	} catch {
		throw new OlgaRefusal("Contract count is not a finite decimal.");
	}
	if (units <= 0n) {
		throw new OlgaRefusal(
			"Contract count must be positive. Zero and negative counts are corrupt.",
		);
	}
	return units;
}

function nonNegativeCount(input: string): bigint {
	let units: bigint;
	try {
		units = parseCount(input);
	} catch {
		throw new OlgaRefusal("Contract count is not a finite decimal.");
	}
	if (units < 0n) {
		throw new OlgaRefusal("Contract count cannot be negative.");
	}
	return units;
}

function nonNegativeMoney(input: string): bigint {
	let units: bigint;
	try {
		units = parseMoney(input);
	} catch {
		throw new OlgaRefusal("Amount is not a finite decimal.");
	}
	if (units < 0n) {
		throw new OlgaRefusal(
			"Amount must be a positive finite decimal. Negative and non-finite values are corrupt.",
		);
	}
	return units;
}

export function buyQuote(input: ReserveInput) {
	return quoteBuyReservation({
		count: input.count,
		price: input.price,
		multiplier: input.feeMultiplier,
		precision: input.balancePrecision,
		feeType: input.feeType,
	});
}

function scale(origin: bigint, size: bigint, requested: bigint): bigint {
	return (origin * size) / requested;
}

function recomputeBuy(reservation: Reservation): Reservation {
	const requested = positiveCount(reservation.count);
	const filled = nonNegativeCount(reservation.filled);
	const cancelled = nonNegativeCount(reservation.cancelled);
	const exitReleased = nonNegativeCount(reservation.exitReleased);
	const resting = requested - filled - cancelled;
	if (resting < 0n || exitReleased > filled) {
		throw new OlgaRefusal("Fill accounting exceeds the original reservation.");
	}
	const quote = buyQuote(reservation);
	if (
		reservation.originNotional !== quote.notional ||
		reservation.originEntryFee !== quote.entryFee ||
		reservation.originExitFee !== quote.exitFee
	) {
		throw new OlgaRefusal(
			"Saved hold does not match the fee-inclusive quote for the count and price.",
		);
	}
	const reservedNotional = formatMoney(
		scale(parseMoney(quote.notional), resting, requested),
	);
	const reservedEntryFee = formatMoney(
		scale(parseMoney(quote.entryFee), resting, requested),
	);
	const reservedExitFee = formatMoney(
		scale(
			parseMoney(quote.exitFee),
			filled + resting - exitReleased,
			requested,
		),
	);
	const amount = formatMoney(
		parseMoney(reservedNotional) +
			parseMoney(reservedEntryFee) +
			parseMoney(reservedExitFee),
	);
	if (
		reservation.reservedNotional !== reservedNotional ||
		reservation.reservedEntryFee !== reservedEntryFee ||
		reservation.reservedExitFee !== reservedExitFee ||
		reservation.amount !== amount
	) {
		throw new OlgaRefusal(
			"Saved reservation is below the fee-inclusive hold for its remaining size.",
		);
	}
	return reservation;
}

export function auditReservations(reservations: Reservation[]): void {
	const exitPool = new Map<string, bigint>();
	for (const reservation of reservations) {
		positiveCount(reservation.count);
		if (reservation.action === "buy") {
			recomputeBuy(reservation);
			if (reservation.state === "released") continue;
			const key = `${reservation.side}`;
			exitPool.set(
				key,
				(exitPool.get(key) ?? 0n) + parseMoney(reservation.reservedExitFee),
			);
			continue;
		}
		if (reservation.state === "released") continue;
		const quote = buyQuote(reservation);
		const needed = parseMoney(quote.entryFee);
		const key = reservation.side;
		const available = exitPool.get(key) ?? 0n;
		const covered = available < needed ? available : needed;
		const additional = needed - covered;
		exitPool.set(key, available - covered);
		if (parseMoney(reservation.coveredFee) !== covered) {
			throw new OlgaRefusal(
				"Sell reservation double-counts an exit fee that is already held.",
			);
		}
		if (reservation.amount !== formatMoney(additional)) {
			throw new OlgaRefusal(
				"Sell reservation does not match the uncovered exit fee.",
			);
		}
		if (reservation.originNotional !== "0.000000") {
			throw new OlgaRefusal("A sell does not reserve a second notional.");
		}
	}
}

export function createReservation(
	input: ReserveInput,
	existing: Reservation[],
): Reservation {
	const count = formatCount(positiveCount(input.count));
	const price = formatMoney(parseMoney(input.price));
	const normalized: ReserveInput = { ...input, count, price };
	if (input.action === "buy") {
		const quote = buyQuote(normalized);
		const reservation: Reservation = {
			id: randomUUID(),
			clientOrderId: input.clientOrderId,
			side: input.side,
			action: "buy",
			count,
			filled: "0.00",
			cancelled: "0.00",
			exitReleased: "0.00",
			price,
			feeType: input.feeType,
			feeMultiplier: input.feeMultiplier,
			balancePrecision: input.balancePrecision,
			coveredFee: "0.000000",
			originNotional: quote.notional,
			originEntryFee: quote.entryFee,
			originExitFee: quote.exitFee,
			reservedNotional: quote.notional,
			reservedEntryFee: quote.entryFee,
			reservedExitFee: quote.exitFee,
			amount: quote.total,
			state: "held",
		};
		auditReservations([...existing, reservation]);
		return reservation;
	}
	const probe: Reservation = {
		id: randomUUID(),
		clientOrderId: input.clientOrderId,
		side: input.side,
		action: "sell",
		count,
		filled: "0.00",
		cancelled: "0.00",
		exitReleased: "0.00",
		price,
		feeType: input.feeType,
		feeMultiplier: input.feeMultiplier,
		balancePrecision: input.balancePrecision,
		coveredFee: "0.000000",
		originNotional: "0.000000",
		originEntryFee: "0.000000",
		originExitFee: "0.000000",
		reservedNotional: "0.000000",
		reservedEntryFee: "0.000000",
		reservedExitFee: "0.000000",
		amount: "0.000000",
		state: "held",
	};
	const withProbe = [...existing, probe];
	const quote = buyQuote(normalized);
	const needed = parseMoney(quote.entryFee);
	let pool = 0n;
	for (const reservation of existing) {
		if (reservation.state === "released" || reservation.side !== input.side) {
			continue;
		}
		if (reservation.action === "buy") {
			pool += parseMoney(reservation.reservedExitFee);
		} else {
			pool -= parseMoney(reservation.coveredFee);
		}
	}
	if (pool < 0n) pool = 0n;
	const covered = pool < needed ? pool : needed;
	probe.coveredFee = formatMoney(covered);
	probe.amount = formatMoney(needed - covered);
	probe.reservedEntryFee = probe.amount;
	probe.originEntryFee = probe.amount;
	auditReservations(withProbe);
	return probe;
}

export function cashDeltaForFill(fill: {
	action: "buy" | "sell";
	count: string;
	price: string;
	fee: string;
}): string {
	const count = positiveCount(fill.count);
	const price = parseMoney(fill.price);
	const fee = nonNegativeMoney(fill.fee);
	const notional = (price * count) / 100n;
	const delta = fill.action === "buy" ? -(notional + fee) : notional - fee;
	return formatMoney(delta);
}

export function applyFillToReservations(
	reservations: Reservation[],
	fill: OlgaFill,
): Reservation[] {
	const next = reservations.map((reservation) => ({ ...reservation }));
	const intent = next.find(
		(reservation) => reservation.clientOrderId === fill.clientOrderId,
	);
	if (!intent || intent.action !== fill.action) {
		throw new OlgaRefusal("Fill does not match a strategy reservation.");
	}
	const add = positiveCount(fill.count);
	const filled = nonNegativeCount(intent.filled) + add;
	if (
		filled + nonNegativeCount(intent.cancelled) >
		positiveCount(intent.count)
	) {
		throw new OlgaRefusal("Fill accounting exceeds the original reservation.");
	}
	intent.filled = formatCount(filled);
	if (fill.action === "sell") {
		let left = add;
		for (const buy of next) {
			if (left <= 0n || buy.action !== "buy" || buy.side !== intent.side)
				continue;
			if (buy.state === "released") continue;
			const covering =
				nonNegativeCount(buy.filled) - nonNegativeCount(buy.exitReleased);
			if (covering <= 0n) continue;
			const take = covering < left ? covering : left;
			buy.exitReleased = formatCount(nonNegativeCount(buy.exitReleased) + take);
			syncBuy(buy);
			left -= take;
		}
	}
	if (intent.action === "buy") syncBuy(intent);
	if (
		intent.action === "sell" &&
		nonNegativeCount(intent.filled) >= positiveCount(intent.count)
	) {
		intent.state = "released";
		intent.amount = "0.000000";
		intent.coveredFee = "0.000000";
		intent.reservedEntryFee = "0.000000";
		intent.reservedNotional = "0.000000";
		intent.reservedExitFee = "0.000000";
	}
	auditReservations(next);
	return next;
}

function syncBuy(reservation: Reservation): void {
	const requested = positiveCount(reservation.count);
	const filled = nonNegativeCount(reservation.filled);
	const cancelled = nonNegativeCount(reservation.cancelled);
	const exitReleased = nonNegativeCount(reservation.exitReleased);
	const resting = requested - filled - cancelled;
	const quote = buyQuote(reservation);
	reservation.originNotional = quote.notional;
	reservation.originEntryFee = quote.entryFee;
	reservation.originExitFee = quote.exitFee;
	reservation.reservedNotional = formatMoney(
		scale(parseMoney(quote.notional), resting, requested),
	);
	reservation.reservedEntryFee = formatMoney(
		scale(parseMoney(quote.entryFee), resting, requested),
	);
	reservation.reservedExitFee = formatMoney(
		scale(
			parseMoney(quote.exitFee),
			filled + resting - exitReleased,
			requested,
		),
	);
	reservation.amount = formatMoney(
		parseMoney(reservation.reservedNotional) +
			parseMoney(reservation.reservedEntryFee) +
			parseMoney(reservation.reservedExitFee),
	);
}

export type { BalancePrecision };
