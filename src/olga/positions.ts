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

function assertMoneyFields(reservation: Reservation): void {
	tradePrice(reservation.price);
	for (const field of [
		reservation.amount,
		reservation.coveredFee,
		reservation.originNotional,
		reservation.originEntryFee,
		reservation.originExitFee,
		reservation.reservedNotional,
		reservation.reservedEntryFee,
		reservation.reservedExitFee,
	]) {
		nonNegativeMoney(field);
	}
	nonNegativeCount(reservation.filled);
	nonNegativeCount(reservation.cancelled);
	nonNegativeCount(reservation.exitReleased);
}

function restingCount(reservation: Reservation): bigint {
	return (
		positiveCount(reservation.count) -
		nonNegativeCount(reservation.filled) -
		nonNegativeCount(reservation.cancelled)
	);
}

export function auditReservations(reservations: Reservation[]): void {
	const exitPool = new Map<string, bigint>();
	const buyCapacity = new Map<string, bigint>();
	const sellUsed = new Map<string, bigint>();
	for (const reservation of reservations) {
		assertMoneyFields(reservation);
		const resting = restingCount(reservation);
		if (resting < 0n) {
			throw new OlgaRefusal(
				"Fill accounting exceeds the original reservation.",
			);
		}
		if (reservation.action === "buy") {
			recomputeBuy(reservation);
			const closed =
				resting === 0n && parseMoney(reservation.reservedExitFee) === 0n;
			if (reservation.state === "released" && !closed) {
				throw new OlgaRefusal(
					"A release without a filled or cancelled position erases a commitment.",
				);
			}
			if (reservation.state === "released") continue;
			const key = reservation.side;
			exitPool.set(
				key,
				(exitPool.get(key) ?? 0n) + parseMoney(reservation.reservedExitFee),
			);
			buyCapacity.set(
				key,
				(buyCapacity.get(key) ?? 0n) +
					positiveCount(reservation.count) -
					nonNegativeCount(reservation.cancelled),
			);
			continue;
		}
		const requested = positiveCount(reservation.count);
		const originCovered = nonNegativeMoney(reservation.coveredFee);
		const originAdditional = nonNegativeMoney(reservation.originEntryFee);
		if (reservation.originNotional !== "0.000000") {
			throw new OlgaRefusal("A sell does not reserve a second notional.");
		}
		if (reservation.state === "released") {
			if (resting !== 0n || reservation.amount !== "0.000000") {
				throw new OlgaRefusal(
					"A released sell still has an open commitment or a corrupt hold.",
				);
			}
			continue;
		}
		const remainingCovered = scale(originCovered, resting, requested);
		const remainingAdditional = scale(originAdditional, resting, requested);
		if (reservation.amount !== formatMoney(remainingAdditional)) {
			throw new OlgaRefusal(
				"Sell reservation does not match the uncovered exit fee.",
			);
		}
		const key = reservation.side;
		const available = exitPool.get(key) ?? 0n;
		if (remainingCovered > available) {
			throw new OlgaRefusal(
				"Sell reservation double-counts an exit fee that is already held.",
			);
		}
		exitPool.set(key, available - remainingCovered);
		const used =
			(sellUsed.get(key) ?? 0n) +
			requested -
			nonNegativeCount(reservation.cancelled);
		const capacity = buyCapacity.get(key) ?? 0n;
		if (used > capacity) {
			throw new OlgaRefusal(
				"Sell has no bought position. A naked sell cannot create cash.",
			);
		}
		sellUsed.set(key, used);
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

export function tradePrice(input: string): bigint {
	let units: bigint;
	try {
		units = parseMoney(input);
	} catch {
		throw new OlgaRefusal("Price is not a finite decimal inside (0, 1).");
	}
	if (units <= 0n || units >= parseMoney("1.000000")) {
		throw new OlgaRefusal("Price must be inside (0, 1).");
	}
	return units;
}

export function cashDeltaForFill(fill: {
	action: "buy" | "sell";
	count: string;
	price: string;
	fee: string;
}): string {
	const count = positiveCount(fill.count);
	const price = tradePrice(fill.price);
	const fee = nonNegativeMoney(fill.fee);
	const notional = (price * count) / 100n;
	const delta = fill.action === "buy" ? -(notional + fee) : notional - fee;
	return formatMoney(delta);
}

function feeBudget(reservation: Reservation, size: bigint): bigint {
	const requested = positiveCount(reservation.count);
	const quote = buyQuote(reservation);
	return scale(parseMoney(quote.entryFee), size, requested);
}

export function assertFillLedger(
	reservations: Reservation[],
	fills: OlgaFill[],
	realizedPnl: string,
): void {
	const seen = new Set<string>();
	const filledByOrder = new Map<string, bigint>();
	const owned = new Map<string, bigint>();
	let sum = 0n;
	for (const fill of fills) {
		if (seen.has(fill.fillId)) {
			throw new OlgaRefusal("Duplicate fill id. A fill is applied once.");
		}
		seen.add(fill.fillId);
		const reservation = reservations.find(
			(item) =>
				item.clientOrderId === fill.clientOrderId &&
				item.action === fill.action,
		);
		if (!reservation) {
			throw new OlgaRefusal(
				"Fill does not match a reservation. Saved profit without a position is rejected.",
			);
		}
		const price = tradePrice(fill.price);
		const limit = tradePrice(reservation.price);
		if (fill.action === "buy" && price > limit) {
			throw new OlgaRefusal("Buy fill price is above the reserved limit.");
		}
		if (fill.action === "sell" && price < limit) {
			throw new OlgaRefusal("Sell fill price is below the reserved limit.");
		}
		const size = positiveCount(fill.count);
		const fee = nonNegativeMoney(fill.fee);
		if (fee > feeBudget(reservation, size)) {
			throw new OlgaRefusal("Fill fee exceeds the reserved fee for that size.");
		}
		if (fill.cashDelta !== cashDeltaForFill(fill)) {
			throw new OlgaRefusal(
				"Applied fill cash does not match its price, count, and fee.",
			);
		}
		const key = `${fill.action}:${fill.clientOrderId}`;
		const nextFilled = (filledByOrder.get(key) ?? 0n) + size;
		const requested = positiveCount(reservation.count);
		const cancelled = nonNegativeCount(reservation.cancelled);
		if (nextFilled + cancelled > requested) {
			throw new OlgaRefusal(
				"Fill accounting exceeds the original reservation.",
			);
		}
		filledByOrder.set(key, nextFilled);
		const held = owned.get(reservation.side) ?? 0n;
		if (fill.action === "buy") {
			owned.set(reservation.side, held + size);
		} else if (size > held) {
			throw new OlgaRefusal(
				"Sell fill has no bought position. A naked sell cannot create cash.",
			);
		} else {
			owned.set(reservation.side, held - size);
		}
		sum += parseMoney(fill.cashDelta);
	}
	for (const reservation of reservations) {
		const key = `${reservation.action}:${reservation.clientOrderId}`;
		const recorded = filledByOrder.get(key) ?? 0n;
		if (nonNegativeCount(reservation.filled) !== recorded) {
			throw new OlgaRefusal(
				"Reserved filled quantity does not match the identified fills.",
			);
		}
	}
	if (formatMoney(finiteMoneySafe(realizedPnl)) !== formatMoney(sum)) {
		throw new OlgaRefusal(
			"Realized profit is not the sum of identified fills. Unrealized profit is not spendable.",
		);
	}
}

function finiteMoneySafe(input: string): bigint {
	try {
		return parseMoney(input);
	} catch {
		throw new OlgaRefusal("Realized result is not a finite decimal.");
	}
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
	const price = tradePrice(fill.price);
	const limit = tradePrice(intent.price);
	if (fill.action === "buy" && price > limit) {
		throw new OlgaRefusal("Buy fill price is above the reserved limit.");
	}
	if (fill.action === "sell" && price < limit) {
		throw new OlgaRefusal("Sell fill price is below the reserved limit.");
	}
	if (nonNegativeMoney(fill.fee) > feeBudget(intent, add)) {
		throw new OlgaRefusal("Fill fee exceeds the reserved fee for that size.");
	}
	if (fill.action === "sell") {
		let owned = 0n;
		for (const buy of next) {
			if (buy.action !== "buy" || buy.side !== intent.side) continue;
			if (buy.state === "released") continue;
			owned +=
				nonNegativeCount(buy.filled) - nonNegativeCount(buy.exitReleased);
		}
		if (add > owned) {
			throw new OlgaRefusal(
				"Sell fill has no bought position. A naked sell cannot create cash.",
			);
		}
		let left = add;
		for (const buy of next) {
			if (left <= 0n || buy.action !== "buy" || buy.side !== intent.side) {
				continue;
			}
			if (buy.state === "released") continue;
			const covering =
				nonNegativeCount(buy.filled) - nonNegativeCount(buy.exitReleased);
			if (covering <= 0n) continue;
			const take = covering < left ? covering : left;
			buy.exitReleased = formatCount(nonNegativeCount(buy.exitReleased) + take);
			syncBuy(buy);
			left -= take;
		}
		if (left > 0n) {
			throw new OlgaRefusal(
				"Sell fill has no bought position. A naked sell cannot create cash.",
			);
		}
	}
	intent.filled = formatCount(filled);
	if (intent.action === "buy") syncBuy(intent);
	if (intent.action === "sell") syncSell(intent);
	if (restingCount(intent) === 0n && intent.action === "sell") {
		intent.state = "released";
	}
	auditReservations(next);
	return next;
}

function syncSell(reservation: Reservation): void {
	const requested = positiveCount(reservation.count);
	const resting = restingCount(reservation);
	reservation.amount = formatMoney(
		scale(parseMoney(reservation.originEntryFee), resting, requested),
	);
	reservation.reservedEntryFee = reservation.amount;
	reservation.reservedNotional = "0.000000";
	reservation.reservedExitFee = "0.000000";
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
