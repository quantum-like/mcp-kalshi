import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireHostLock } from "../src/olga/lock.js";
import {
	applyOlgaFill,
	externalAnchorPath,
	initializeDisabledCandidate,
	loadOlgaState,
	markSubmitting,
	markUnknown,
	releaseUnsent,
	reserve,
	saveRisk,
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
		ticker: "KXBTC15M-FAKE",
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
		ticker: "KXBTC15M-FAKE",
		outcomeSide: "yes" as const,
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

test("market identity is required and a different ticker cannot book or cover inventory", async () => {
	const { directory, risk } = await freshRisk();
	try {
		assert.throws(
			() => reserve(risk, { ...order("bare"), ticker: "" }),
			/ticker/i,
		);
		const reserved = reserve(risk, order("A-buy"));
		assert.equal(reserved.reservations[0]?.ticker, "KXBTC15M-FAKE");
		assert.throws(
			() =>
				applyOlgaFill(
					reserved,
					fill("A-buy", "buy", { ticker: "KXBTC15M-FAKE-B" }),
				),
			/market|instrument/i,
		);
		const bought = applyOlgaFill(reserved, fill("A-buy"));
		assert.throws(
			() =>
				reserve(bought, {
					...order("B-sell", "sell"),
					ticker: "KXBTC15M-FAKE-B",
				}),
			/no bought position|naked sell/i,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("unsent release cancels the resting hold and tampered exits or duplicate ids fail", async () => {
	const { directory, risk } = await freshRisk();
	try {
		const reserved = reserve(risk, order("buy"));
		const unsent = releaseUnsent(reserved, "buy", true);
		assert.equal(unsent.reservations[0]?.state, "released");
		assert.equal(unsent.allocated, "0.000000");
		assert.equal(spendableUnits(unsent), 5_000000n);
		const submitting = markSubmitting(
			reserve(risk, order("inflight")),
			"inflight",
		);
		assert.throws(
			() => releaseUnsent(submitting, "inflight", true),
			/In-flight|never sent/,
		);
		assert.equal(submitting.allocated, "0.555000");
		const bought = applyOlgaFill(reserve(risk, order("held")), fill("held"));
		const erased = structuredClone(bought);
		erased.reservations[0].exitReleased = "1.00";
		erased.reservations[0].reservedExitFee = "0.000000";
		erased.reservations[0].amount = "0.000000";
		erased.allocated = "0.000000";
		await writeFile(join(directory, "olga-risk.json"), JSON.stringify(erased));
		const exitGone = await loadOlgaState(directory);
		assert.equal(exitGone.ok, false);
		const linked = reserve(bought, {
			...order("sell", "sell"),
			feeMultiplier: "2.000000",
		});
		assert.notEqual(linked.reservations[1]?.amount, "0.000000");
		const widened = structuredClone(linked);
		const sellRow = widened.reservations[1];
		assert.ok(sellRow);
		if (!sellRow) return;
		sellRow.originEntryFee = "0.000000";
		sellRow.reservedEntryFee = "0.000000";
		sellRow.amount = "0.000000";
		widened.allocated = widened.reservations[0]?.amount ?? "0.000000";
		await writeFile(join(directory, "olga-risk.json"), JSON.stringify(widened));
		const feeGone = await loadOlgaState(directory);
		assert.equal(feeGone.ok, false);
		const cloned = structuredClone(reserved);
		cloned.reservations.push({ ...cloned.reservations[0] });
		cloned.allocated = "1.110000";
		await writeFile(join(directory, "olga-risk.json"), JSON.stringify(cloned));
		const duplicate = await loadOlgaState(directory);
		assert.equal(duplicate.ok, false);
		assert.match(duplicate.ok ? "" : duplicate.reason, /Duplicate reservation/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("replacing the state directory does not admit a second holder", async () => {
	const { directory } = await freshRisk();
	const first = await acquireHostLock(directory);
	const parent = join(directory, "..");
	const base = directory.split("/").at(-1) ?? "state";
	const moved = join(parent, `${base}-moved`);
	try {
		const { rename, cp } = await import("node:fs/promises");
		await rename(directory, moved);
		await cp(moved, directory, { recursive: true });
		await assert.rejects(acquireHostLock(directory), /No fallback host/);
		await assert.rejects(first.assertBound(), /identity changed/);
	} finally {
		await first.release();
		await rm(directory, { recursive: true, force: true });
		await rm(moved, { recursive: true, force: true }).catch(() => undefined);
		await rm(join(parent, `.olga-a1.${base}.lockdir`), {
			recursive: true,
			force: true,
		}).catch(() => undefined);
	}
});

test("a contradictory fill outcome is rejected and a coherent rewrite without the anchor is refused", async () => {
	const { directory, risk } = await freshRisk();
	try {
		const reserved = reserve(risk, order("buy"));
		assert.throws(
			() =>
				applyOlgaFill(reserved, {
					...fill("buy"),
					outcomeSide: "no",
				}),
			/outcome/i,
		);
		const bought = applyOlgaFill(reserved, fill("buy"));
		await writeFile(join(directory, "olga-risk.json"), JSON.stringify(bought));
		const rewritten = await loadOlgaState(directory);
		assert.equal(rewritten.ok, false);
		assert.match(
			rewritten.ok ? "" : rewritten.reason,
			/anchor|fingerprint|rolled-back/,
		);
		const { outcomeSide: _outcomeSide, ...missing } = fill("buy");
		assert.throws(
			() => applyOlgaFill(reserved, missing as ReturnType<typeof fill>),
			/outcome/i,
		);
		assert.equal(_outcomeSide, "yes");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("in-flight and partial commitments stay reserved without cancellation proof", async () => {
	const { directory, risk } = await freshRisk();
	try {
		const held = reserve(risk, order("never"));
		const freed = releaseUnsent(held, "never", true);
		assert.equal(freed.reservations[0]?.state, "released");
		assert.equal(freed.allocated, "0.000000");
		const submitting = markSubmitting(reserve(risk, order("sent")), "sent");
		assert.equal(submitting.reservations[0]?.dispatch, "started");
		assert.throws(
			() => releaseUnsent(submitting, "sent", true),
			/never sent|In-flight/,
		);
		assert.equal(submitting.allocated, "0.555000");
		const partial = applyOlgaFill(
			reserve(risk, order("part")),
			fill("part", "buy", { count: "0.50", fee: "0.010000" }),
		);
		assert.equal(partial.reservations[0]?.dispatch, "started");
		assert.notEqual(partial.allocated, "0.000000");
		assert.throws(
			() => releaseUnsent(partial, "part", true),
			/never sent|not unsent|In-flight/,
		);
		assert.notEqual(partial.allocated, "0.000000");
		const unknown = markUnknown(reserve(risk, order("unknown")), "unknown");
		assert.throws(
			() => releaseUnsent(unknown, "unknown", false),
			/never sent|In-flight|unknown|Incomplete read/i,
		);
		assert.equal(unknown.reservations[0]?.state, "unknown");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("coherent fee rewrites, snapshot rollback, and market relabel fail closed", async () => {
	const { directory, risk } = await freshRisk();
	try {
		const bought = applyOlgaFill(reserve(risk, order("buy")), fill("buy"));
		await saveRisk(directory, bought);
		const before = await readFile(join(directory, "olga-risk.json"));
		const later = releaseUnsent(reserve(risk, order("other")), "other", true);
		await saveRisk(directory, later);
		await writeFile(join(directory, "olga-risk.json"), before);
		const rolled = await loadOlgaState(directory);
		assert.equal(rolled.ok, false);
		assert.match(
			rolled.ok ? "" : rolled.reason,
			/fingerprint|rolled-back|anchor/,
		);

		await saveRisk(directory, bought);
		const book = JSON.parse(
			await readFile(join(directory, "olga-risk.json"), "utf8"),
		) as {
			realizedPnl: string;
			reservations: Array<{ ticker: string; side: string }>;
			appliedFills: Array<{
				ticker: string;
				outcomeSide: string;
				fee: string;
				cashDelta: string;
			}>;
		};
		const row = book.reservations[0];
		const applied = book.appliedFills[0];
		assert.ok(row && applied);
		applied.fee = "0.000000";
		applied.cashDelta = "-0.500000";
		book.realizedPnl = "-0.500000";
		await writeFile(join(directory, "olga-risk.json"), JSON.stringify(book));
		const cheaper = await loadOlgaState(directory);
		assert.equal(cheaper.ok, false);
		assert.match(
			cheaper.ok ? "" : cheaper.reason,
			/fingerprint|rolled-back|anchor/,
		);

		await saveRisk(directory, bought);
		const relabeled = JSON.parse(
			await readFile(join(directory, "olga-risk.json"), "utf8"),
		) as typeof book;
		const reservation = relabeled.reservations[0];
		const fillRow = relabeled.appliedFills[0];
		assert.ok(reservation && fillRow);
		reservation.ticker = "KXETH15M-FAKE";
		reservation.side = "no";
		fillRow.ticker = "KXETH15M-FAKE";
		fillRow.outcomeSide = "no";
		await writeFile(
			join(directory, "olga-risk.json"),
			JSON.stringify(relabeled),
		);
		const moved = await loadOlgaState(directory);
		assert.equal(moved.ok, false);
		assert.match(
			moved.ok ? "" : moved.reason,
			/fingerprint|anchor|rolled-back/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rewriting the book and the sibling anchor together is outside this fence", async () => {
	const { directory, risk } = await freshRisk();
	try {
		const bought = applyOlgaFill(reserve(risk, order("buy")), fill("buy"));
		await saveRisk(directory, bought);
		const names = [
			"olga-manifest.json",
			"olga-owner.json",
			"olga-risk.json",
			"olga-policy.json",
			"olga-binding.json",
			"olga-clock.json",
		];
		const book = JSON.parse(
			await readFile(join(directory, "olga-risk.json"), "utf8"),
		) as {
			realizedPnl: string;
			appliedFills: Array<{ fee: string; cashDelta: string }>;
		};
		const applied = book.appliedFills[0];
		assert.ok(applied);
		applied.fee = "0.000000";
		applied.cashDelta = "-0.500000";
		book.realizedPnl = "-0.500000";
		await writeFile(join(directory, "olga-risk.json"), JSON.stringify(book));
		const hash = createHash("sha256");
		for (const name of names) {
			hash.update(name);
			hash.update("\0");
			hash.update(await readFile(join(directory, name)));
			hash.update("\0");
		}
		const info = await stat(directory);
		const prior = JSON.parse(
			await readFile(externalAnchorPath(directory), "utf8"),
		) as { generation: number };
		await writeFile(
			externalAnchorPath(directory),
			`${JSON.stringify({
				version: 1,
				generation: prior.generation + 1,
				fingerprint: hash.digest("hex"),
				stateDev: String(info.dev),
				stateIno: String(info.ino),
			})}\n`,
		);
		const forged = await loadOlgaState(directory);
		assert.equal(forged.ok, true);
		if (!forged.ok) return;
		assert.equal(forged.state.risk.realizedPnl, "-0.500000");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
