/** Decimal strings scaled to integers. Accounting never uses binary floats. */

const DECIMAL = /^[+-]?\d+(\.\d+)?$/;

export function parseScaled(input: string, scale: number): bigint {
	if (typeof input !== "string" || !DECIMAL.test(input.trim())) {
		throw new Error(`Invalid decimal string: ${input}`);
	}
	const trimmed = input.trim();
	const negative = trimmed.startsWith("-");
	const raw = trimmed.replace(/^[+-]/, "");
	const [whole, fraction = ""] = raw.split(".");
	if (fraction.length > scale) {
		throw new Error(`More than ${scale} decimal places: ${input}`);
	}
	const digits = `${whole}${fraction.padEnd(scale, "0")}`.replace(
		/^0+(?=\d)/,
		"",
	);
	const value = BigInt(digits === "" ? "0" : digits);
	return negative ? -value : value;
}

export function formatScaled(units: bigint, scale: number): string {
	const negative = units < 0n;
	const absolute = (negative ? -units : units)
		.toString()
		.padStart(scale + 1, "0");
	const whole = absolute.slice(0, -scale);
	const fraction = absolute.slice(-scale);
	return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export const MONEY_SCALE = 6;
export const COUNT_SCALE = 2;

export function parseMoney(input: string): bigint {
	return parseScaled(input, MONEY_SCALE);
}

export function formatMoney(units: bigint): string {
	return formatScaled(units, MONEY_SCALE);
}

export function parseCount(input: string): bigint {
	return parseScaled(input, COUNT_SCALE);
}

export function formatCount(units: bigint): string {
	return formatScaled(units, COUNT_SCALE);
}

export function money(input: string): bigint {
	return parseMoney(input);
}

/** Price (scale 6) times count (scale 2), result scale 6, truncated toward zero. */
export function mulPriceCount(price: bigint, count: bigint): bigint {
	return (price * count) / 100n;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
	if (denominator <= 0n) {
		throw new Error("ceilDiv requires a positive denominator");
	}
	if (numerator >= 0n) {
		return (numerator + denominator - 1n) / denominator;
	}
	return -(-numerator / denominator);
}

export function floorToStep(units: bigint, step: bigint): bigint {
	if (step <= 0n) {
		throw new Error("step must be positive");
	}
	const quotient = units / step;
	const remainder = units % step;
	if (remainder === 0n) {
		return units;
	}
	return units >= 0n ? quotient * step : (quotient - 1n) * step;
}

export function cmp(left: bigint, right: bigint): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
