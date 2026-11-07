import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	applyOlgaFill,
	initializeDisabledCandidate,
	loadOlgaState,
	reserve,
	spendableUnits,
} from "../src/olga/state.js";

const NOW = 1_700_000_000_000;

function order(
	id: string,
	action: "buy" | "sell" = "buy",
	price = "0.500000",
	count = "1.00",
) {
	return {
		clientOrderId: id,
		side: "yes" as const,
		action,
		count,
		price,
		feeType: "quadratic",
		feeMultiplier: "1.000000",
		balancePrecision: "0.01" as const,
	};
}

function fill(
	id: string,
	action: "buy" | "sell" = "buy",
	more: Record<string, string> = {},
) {
	return {
		fillId: `fill-${id}`,
		clientOrderId: id,
		action,
		count: "1.00",
		price: "0.500000",
		fee: "0.020000",
		...more,
	};
}

async function freshRisk() {
	const directory = await mkdtemp(join(tmpdir(), "olga-attack-"));
	const state = await initializeDisabledCandidate(directory, NOW);
	return { directory, risk: state.risk };
}

test("fabricated and duplicate saved fills cannot create spendable profit", async () => {
	const { directory, risk } = await freshRisk();
	try {
		const forged = {
			...risk,
			realizedPnl: "100.000000",
			appliedFills: [
				{
					fillId: "invented",
					clientOrderId: "missing",
					action: "sell",
					count: "1000.00",
					price: "0.100000",
					fee: "0.000000",
					cashDelta: "100.000000",
				},
			],
		};
		await writeFile(join(directory, "olga-risk.json"), JSON.stringify(forged));
		const loaded = await loadOlgaState(directory);
		assert.equal(loaded.ok, false);
		const duplicate = {
			...risk,
			realizedPnl: "1.000000",
			appliedFills: [
				{
					fillId: "same",
					clientOrderId: "missing",
					action: "sell",
					count: "1.00",
					price: "0.500000",
					fee: "0.000000",
					cashDelta: "0.500000",
				},
				{
					fillId: "same",
					clientOrderId: "missing",
					action: "sell",
					count: "1.00",
					price: "0.500000",
					fee: "0.000000",
					cashDelta: "0.500000",
				},
			],
		};
		await writeFile(
			join(directory, "olga-risk.json"),
			JSON.stringify(duplicate),
		);
		const again = await loadOlgaState(directory);
		assert.equal(again.ok, false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a naked sell cannot create cash", async () => {
	const { directory, risk } = await freshRisk();
	try {
		assert.throws(
			() => reserve(risk, order("naked", "sell")),
			/no bought position|naked sell/i,
		);
		const bought = applyOlgaFill(reserve(risk, order("buy")), fill("buy"));
		assert.throws(
			() =>
				applyOlgaFill(
					reserve(bought, order("sell", "sell", "0.990000")),
					fill("sell", "sell", {
						price: "0.990000",
						fee: "0.000000",
						count: "2.00",
					}),
				),
			/naked sell|exceeds the original/i,
		);
		assert.ok(spendableUnits(bought) <= 5_000000n);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("buy fills reject negative, unit, and above-limit prices", async () => {
	const { directory, risk } = await freshRisk();
	try {
		const reserved = reserve(risk, order("buy"));
		for (const price of ["-1.000000", "1.010000", "0.990000", "0.000000"]) {
			assert.throws(
				() =>
					applyOlgaFill(
						reserved,
						fill("buy", "buy", { price, fee: "0.000000" }),
					),
				/price|limit/i,
				price,
			);
		}
		const accepted = applyOlgaFill(
			reserved,
			fill("buy", "buy", { price: "0.400000", fee: "0.010000" }),
		);
		assert.ok(spendableUnits(accepted) < 5_000000n);
		assert.equal(accepted.externalCapital, "5.000000");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a partial sell releases holds without throwing or double counting", async () => {
	const { directory, risk } = await freshRisk();
	try {
		let book = reserve(risk, order("buy"));
		book = applyOlgaFill(book, fill("buy"));
		book = reserve(book, order("sell", "sell"));
		book = applyOlgaFill(
			book,
			fill("sell", "sell", {
				fillId: "fill-sell-a",
				count: "0.50",
				fee: "0.010000",
			}),
		);
		assert.notEqual(book.allocated, "0.000000");
		book = applyOlgaFill(
			book,
			fill("sell", "sell", {
				fillId: "fill-sell-b",
				count: "0.50",
				fee: "0.010000",
			}),
		);
		assert.equal(book.allocated, "0.000000");
		assert.equal(spendableUnits(book), 4_960000n);
		assert.equal(book.externalCapital, "5.000000");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a forged release cannot erase an open buy, and released history stays finite", async () => {
	const { directory, risk } = await freshRisk();
	try {
		const reserved = reserve(risk, order("buy"));
		const released = structuredClone(reserved);
		released.reservations[0].state = "released";
		released.allocated = "0.000000";
		await writeFile(
			join(directory, "olga-risk.json"),
			JSON.stringify(released),
		);
		const hidden = await loadOlgaState(directory);
		assert.equal(hidden.ok, false);
		assert.match(hidden.ok ? "" : hidden.reason, /release|commitment/i);
		let closed = applyOlgaFill(reserved, fill("buy"));
		closed = reserve(closed, order("sell", "sell"));
		closed = applyOlgaFill(closed, fill("sell", "sell"));
		await writeFile(join(directory, "olga-risk.json"), JSON.stringify(closed));
		for (const [field, value] of [
			["price", "NaN"],
			["amount", "-1.000000"],
			["originEntryFee", "Infinity"],
			["filled", "-1.00"],
		] as const) {
			const forged = structuredClone(closed);
			const sell = forged.reservations.find((item) => item.action === "sell");
			assert.ok(sell);
			if (!sell) return;
			(sell as unknown as Record<string, string>)[field] = value;
			await writeFile(
				join(directory, "olga-risk.json"),
				JSON.stringify(forged),
			);
			const loaded = await loadOlgaState(directory);
			assert.equal(loaded.ok, false, field);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
