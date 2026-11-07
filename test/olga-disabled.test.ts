import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
	mkdtemp,
	readFile,
	readdir,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { formatMoney } from "../src/lib/fixed.js";
import { MAX_AWAKE_GAP_MS, decideOlga } from "../src/olga/decide.js";
import { acquireHostLock } from "../src/olga/lock.js";
import {
	MAX_EXTERNAL_CAPITAL,
	OLGA_HOME,
	OLGA_MACHINE_ID,
	SEALED_POLICY_IDS,
	bookRealized,
	feeInclusiveHold,
	initializeDisabledCandidate,
	loadOlgaState,
	markSubmitting,
	markUnknown,
	rejectExternalTopUp,
	rejectUnrealizedSpend,
	releaseUnsent,
	reserve,
	saveBinding,
	saveRisk,
	spendableUnits,
} from "../src/olga/state.js";
import { OLGA_DISABLED, runDisabledTick } from "../src/olga/tick.js";

const NOW = 1_700_000_000_000;

function observedBound() {
	return {
		apiKeyId: "a1-key-id",
		memberId: "member-a1",
		subaccount: 1,
		keyPresent: true,
		keychainService: "mcp-kalshi-a1",
		readsComplete: true,
	};
}

async function freshDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "olga-a1-"));
}

function order(
	id: string,
	action: "buy" | "sell" = "buy",
	side: "yes" | "no" = "yes",
	count = "1.00",
	price = "0.500000",
) {
	return {
		clientOrderId: id,
		action,
		side,
		count,
		price,
		feeType: "quadratic" as const,
		feeMultiplier: "1.000000",
		balancePrecision: "0.01" as const,
	};
}

function tick(directory: string, nowMs = NOW + 1_000) {
	return {
		directory,
		nowMs,
		feedAtMs: nowMs,
		exchangeNowMs: nowMs,
		observedMachineId: OLGA_MACHINE_ID,
		observedHome: OLGA_HOME,
		observed: observedBound(),
	};
}

async function ready(directory: string) {
	await initializeDisabledCandidate(directory, NOW);
	const loaded = await loadOlgaState(directory);
	assert.equal(loaded.ok, true);
	if (!loaded.ok) throw new Error("state did not load");
	await saveBinding(directory, {
		...loaded.state.binding,
		bound: true,
		apiKeyId: "a1-key-id",
		memberId: "member-a1",
		subaccount: 1,
		distinctFromMemberId: "member-a2",
	});
}

test("external capital stays 5 while realized profit is reusable and losses deduct", async () => {
	const directory = await freshDir();
	try {
		await initializeDisabledCandidate(directory, NOW);
		let loaded = await loadOlgaState(directory);
		assert.equal(loaded.ok, true);
		if (!loaded.ok) return;
		const first = reserve(
			loaded.state.risk,
			order("buy-10", "buy", "yes", "10.00", "0.400000"),
		);
		assert.equal(first.reservations[0]?.amount, "4.363000");
		assert.notEqual(first.reservations[0]?.amount, "4.000000");
		const second = reserve(first, order("extra-a"));
		assert.throws(() => reserve(second, order("extra-b")), /exceeds spendable/);
		const withProfit = bookRealized(second, "1.000000");
		assert.equal(withProfit.realizedPnl, "1.000000");
		const afterProfit = reserve(withProfit, order("extra-b"));
		assert.equal(afterProfit.reservations.length, 3);
		const withLoss = bookRealized(afterProfit, "-0.250000");
		assert.equal(withLoss.realizedPnl, "0.750000");
		assert.ok(spendableUnits(withLoss) < spendableUnits(afterProfit));
		await saveRisk(directory, withLoss);
		loaded = await loadOlgaState(directory);
		assert.equal(loaded.ok, true);
		if (!loaded.ok) return;
		assert.equal(loaded.state.risk.externalCapital, MAX_EXTERNAL_CAPITAL);
		assert.throws(() => rejectExternalTopUp(), /cannot be topped up/);
		assert.throws(
			() => rejectUnrealizedSpend(),
			/Unrealized profit is not spendable/,
		);
		const raw = JSON.parse(
			await readFile(join(directory, "olga-risk.json"), "utf8"),
		) as { externalCapital: string; unrealized?: string };
		raw.externalCapital = "6.000000";
		await writeFile(join(directory, "olga-risk.json"), JSON.stringify(raw));
		const tampered = await loadOlgaState(directory);
		assert.equal(tampered.ok, false);
		assert.match(tampered.ok ? "" : tampered.reason, /initial 5\.000000/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a1 account binding rejects a2, a different member, and an incomplete read", async () => {
	const directory = await freshDir();
	try {
		await ready(directory);
		const base = tick(directory);
		const a2 = await runDisabledTick({ ...base, profile: "a2" });
		assert.equal(a2.action, "STOP");
		assert.match(a2.reasons[0] ?? "", /a2 profile/);
		const otherMachine = await runDisabledTick({
			...base,
			observedMachineId: "00000000-0000-0000-0000-000000000000",
		});
		assert.match(otherMachine.reasons[0] ?? "", /Machine fence/);
		const otherMember = await runDisabledTick({
			...base,
			observed: { ...observedBound(), memberId: "member-a2" },
		});
		assert.match(otherMember.reasons[0] ?? "", /rejected account|Member id/);
		const otherSub = await runDisabledTick({
			...base,
			observed: { ...observedBound(), subaccount: 0 },
		});
		assert.match(otherSub.reasons[0] ?? "", /Subaccount/);
		const incomplete = await runDisabledTick({
			...base,
			observed: { ...observedBound(), readsComplete: false },
		});
		assert.match(incomplete.reasons[0] ?? "", /incomplete/);
		const foreignKeychain = await runDisabledTick({
			...base,
			observed: { ...observedBound(), keychainService: "mcp-kalshi-a2" },
		});
		assert.match(foreignKeychain.reasons[0] ?? "", /separate a1/);
		for (const decision of [
			a2,
			otherMember,
			otherSub,
			incomplete,
			foreignKeychain,
		]) {
			assert.equal(decision.submits, 0);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("reservations survive a new process load and are not reset", async () => {
	const directory = await freshDir();
	try {
		await initializeDisabledCandidate(directory, NOW);
		const first = await loadOlgaState(directory);
		assert.equal(first.ok, true);
		if (!first.ok) return;
		await saveRisk(directory, reserve(first.state.risk, order("durable-1")));
		const second = await loadOlgaState(directory);
		assert.equal(second.ok, true);
		if (!second.ok) return;
		assert.equal(second.state.risk.allocated, "0.555000");
		assert.equal(second.state.risk.reservations[0]?.state, "held");
		assert.equal(second.state.risk.externalCapital, "5.000000");
		assert.equal(second.state.risk.realizedPnl, "0.000000");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an unknown order outcome is not retried or released", async () => {
	const directory = await freshDir();
	try {
		await ready(directory);
		const loaded = await loadOlgaState(directory);
		assert.equal(loaded.ok, true);
		if (!loaded.ok) return;
		const held = reserve(loaded.state.risk, order("unknown-1"));
		await saveRisk(directory, markUnknown(held, "unknown-1"));
		const input = tick(directory);
		const first = await runDisabledTick(input);
		const second = await runDisabledTick(input);
		assert.equal(first.action, "STOP");
		assert.equal(first.retries, 0);
		assert.equal(first.submits, 0);
		assert.match(first.reasons[0] ?? "", /Unknown order outcome/);
		assert.equal(second.retries, 0);
		const after = await loadOlgaState(directory);
		assert.equal(after.ok, true);
		if (!after.ok) return;
		assert.equal(after.state.risk.reservations[0]?.state, "unknown");
		assert.throws(
			() => reserve(after.state.risk, order("unknown-2")),
			/not retried|unknown order/i,
		);
		assert.throws(
			() => releaseUnsent(after.state.risk, "unknown-1", true),
			/Unknown order outcome stays reserved/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an orphan submitting order stops and is not released by the tick", async () => {
	const directory = await freshDir();
	try {
		await ready(directory);
		const loaded = await loadOlgaState(directory);
		assert.equal(loaded.ok, true);
		if (!loaded.ok) return;
		const held = reserve(loaded.state.risk, order("orphan-1"));
		await saveRisk(directory, markSubmitting(held, "orphan-1"));
		const decision = await runDisabledTick(tick(directory));
		assert.equal(decision.action, "STOP");
		assert.match(decision.reasons[0] ?? "", /Orphan submitting/);
		assert.equal(decision.submits, 0);
		const after = await loadOlgaState(directory);
		assert.equal(after.ok, true);
		if (!after.ok) return;
		assert.equal(after.state.risk.reservations[0]?.state, "submitting");
		assert.throws(
			() => releaseUnsent(after.state.risk, "orphan-1", false),
			/Incomplete read/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a killed holder releases the kernel lock and a foreign host is not adopted", async () => {
	const directory = await freshDir();
	const lockPath = join(directory, "olga-host.lock");
	const compiled = resolve("dist/olga/lock.js");
	const wrapper = join(directory, "hold.mjs");
	const command = existsSync(compiled)
		? [wrapper, lockPath]
		: ["--import", "tsx", resolve("test/helpers/olga-hold.ts"), lockPath];
	if (existsSync(compiled)) {
		await writeFile(
			wrapper,
			`import { acquireHostLock } from ${JSON.stringify(pathToFileURL(compiled).href)};\nconst lock = await acquireHostLock(process.argv[2]);\nprocess.stdout.write("held\\n");\nsetInterval(() => { void lock; }, 1000);\n`,
		);
	}
	const holder = spawn(process.execPath, command, {
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		let seen = "";
		let errors = "";
		holder.stdout?.setEncoding("utf8");
		holder.stderr?.setEncoding("utf8");
		holder.stdout?.on("data", (chunk: string) => {
			seen += chunk;
		});
		holder.stderr?.on("data", (chunk: string) => {
			errors += chunk;
		});
		const started = Date.now();
		while (!seen.includes("held")) {
			if (holder.exitCode !== null || Date.now() - started > 5_000) {
				throw new Error(`holder did not lock: ${seen} ${errors}`);
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
		}
		await assert.rejects(acquireHostLock(lockPath), /No fallback host/);
		assert.ok(holder.pid);
		process.kill(holder.pid, "SIGKILL");
		await once(holder, "exit");
		const reacquired = await acquireHostLock(lockPath);
		await reacquired.release();
		await initializeDisabledCandidate(directory, NOW);
		await writeFile(
			join(directory, "olga-owner.json"),
			JSON.stringify({
				version: 1,
				hostId: "olga",
				profile: "a1",
				fallback: "auto",
			}),
		);
		const decision = await runDisabledTick(tick(directory));
		assert.equal(decision.action, "STOP");
		assert.match(decision.reasons[0] ?? "", /text host label/);
		const owner = await readFile(join(directory, "olga-owner.json"), "utf8");
		assert.match(owner, /"hostId":"olga"/);
		assert.equal(OLGA_MACHINE_ID, "f79c77c4-4b66-4a92-9669-f49bf82f9e59");
		assert.equal(OLGA_HOME, "/Users/olgavlasova");
	} finally {
		if (holder.exitCode === null) holder.kill("SIGKILL");
		await rm(directory, { recursive: true, force: true });
	}
});

test("a missing or unknown a1 key stops the tick", async () => {
	const directory = await freshDir();
	try {
		await ready(directory);
		for (const keyPresent of [false, null]) {
			const decision = await runDisabledTick({
				...tick(directory),
				observed: { ...observedBound(), keyPresent },
			});
			assert.equal(decision.action, "STOP");
			assert.match(
				decision.reasons[0] ?? "",
				/Keychain item is missing or unknown/,
			);
			assert.equal(decision.submits, 0);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the Olga candidate is disabled and the plist is not a schedule", async () => {
	assert.equal(OLGA_DISABLED, true);
	const directory = await freshDir();
	try {
		const decision = await runDisabledTick({
			directory,
			nowMs: NOW,
			feedAtMs: null,
			observed: {
				apiKeyId: null,
				memberId: null,
				subaccount: null,
				keyPresent: null,
				keychainService: null,
				readsComplete: false,
			},
		});
		assert.equal(decision.action, "STOP");
		assert.match(decision.reasons[0] ?? "", /not initialized/);
		const names = await readdir(directory);
		assert.equal(names.includes("olga-manifest.json"), false);
		assert.equal(names.includes("olga-risk.json"), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	const plist = await readFile(
		"deploy/olga/com.quantumlike.mcp-kalshi.a1.olga.disabled.plist",
		"utf8",
	);
	assert.match(plist, /<string>\/usr\/bin\/false<\/string>/);
	assert.equal(/<key>StartInterval<\/key>/.test(plist), false);
	assert.equal(/<key>StartCalendarInterval<\/key>/.test(plist), false);
	assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
	assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
	assert.equal(plist.includes("launchctl"), false);
	const tickSource = await readFile("src/olga/tick.ts", "utf8");
	assert.equal(tickSource.includes("launchctl"), false);
	assert.equal(tickSource.includes("KALSHI_PRIVATE_KEY"), false);
	assert.equal(tickSource.includes("enableOlga"), false);
});

test("unknown and unvalidated policy waits and live learning is refused", async () => {
	assert.equal(SEALED_POLICY_IDS.length, 0);
	const directory = await freshDir();
	try {
		await ready(directory);
		const input = tick(directory);
		const waiting = await runDisabledTick(input);
		assert.equal(waiting.action, "WAIT");
		assert.match(waiting.reasons[0] ?? "", /not a profitability claim/);
		assert.equal(waiting.submits, 0);
		const policy = JSON.parse(
			await readFile(join(directory, "olga-policy.json"), "utf8"),
		) as {
			policyId: string;
			gates: Record<string, boolean>;
			liveLearning?: boolean;
		};
		policy.policyId = "forged-adaptive";
		for (const gate of Object.keys(policy.gates)) policy.gates[gate] = true;
		await writeFile(
			join(directory, "olga-policy.json"),
			JSON.stringify(policy),
		);
		const forged = await runDisabledTick(input);
		assert.equal(forged.action, "WAIT");
		assert.match(forged.reasons[0] ?? "", /unknown or unvalidated/i);
		const loaded = await loadOlgaState(directory);
		assert.equal(loaded.ok, true);
		if (!loaded.ok) return;
		const inMemory = decideOlga(
			{
				...loaded.state,
				policy: {
					...loaded.state.policy,
					policyId: "still-unknown",
					gates: {
						fit: true,
						prereg: true,
						validate: true,
						matchedHistory: true,
						sourceDate: true,
						readParity: true,
						accountBound: true,
					},
				},
			},
			input,
		);
		assert.equal(inMemory.action, "WAIT");
		policy.liveLearning = true;
		await writeFile(
			join(directory, "olga-policy.json"),
			JSON.stringify(policy),
		);
		const learning = await runDisabledTick(input);
		assert.equal(learning.action, "STOP");
		assert.match(learning.reasons[0] ?? "", /Live learning|adaptation/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("sleep, a stale feed, and a missing file fail closed with no fallback", async () => {
	const directory = await freshDir();
	const staleDirectory = await freshDir();
	try {
		await ready(staleDirectory);
		const stale = await runDisabledTick({
			...tick(staleDirectory),
			feedAtMs: NOW - 20_000,
		});
		assert.equal(stale.action, "STOP");
		assert.match(stale.reasons[0] ?? "", /Market feed is stale/);
		await ready(directory);
		const slept = await runDisabledTick({
			...tick(directory, NOW + MAX_AWAKE_GAP_MS + 1),
		});
		assert.equal(slept.action, "STOP");
		assert.match(slept.reasons[0] ?? "", /No catch-up/);
		const later = await runDisabledTick(
			tick(directory, NOW + MAX_AWAKE_GAP_MS + 2_000),
		);
		assert.match(later.reasons[0] ?? "", /No catch-up/);
		await unlink(join(directory, "olga-risk.json"));
		const partial = await runDisabledTick(tick(directory));
		assert.match(partial.reasons[0] ?? "", /replenish/);
		const names = await readdir(directory);
		assert.equal(names.includes("olga-risk.json"), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
		await rm(staleDirectory, { recursive: true, force: true });
	}
});

test("a negative or non-finite saved reservation cannot offset the bankroll", async () => {
	const directory = await freshDir();
	try {
		await initializeDisabledCandidate(directory, NOW);
		const loaded = await loadOlgaState(directory);
		assert.equal(loaded.ok, true);
		if (!loaded.ok) return;
		const raw = JSON.parse(
			await readFile(join(directory, "olga-risk.json"), "utf8"),
		) as {
			allocated: string;
			reservations: Array<Record<string, string>>;
		};
		raw.reservations = [
			{
				id: "neg",
				clientOrderId: "neg",
				side: "yes",
				action: "buy",
				count: "1.00",
				price: "0.500000",
				amount: "-1.000000",
				state: "held",
			},
			{
				id: "six",
				clientOrderId: "six",
				side: "no",
				action: "buy",
				count: "1.00",
				price: "0.500000",
				amount: "6.000000",
				state: "held",
			},
		];
		raw.allocated = "5.000000";
		await writeFile(join(directory, "olga-risk.json"), JSON.stringify(raw));
		const negative = await loadOlgaState(directory);
		assert.equal(negative.ok, false);
		assert.match(negative.ok ? "" : negative.reason, /positive finite/);
		raw.reservations[0].amount = "NaN";
		raw.allocated = "6.000000";
		await writeFile(join(directory, "olga-risk.json"), JSON.stringify(raw));
		const nonFinite = await loadOlgaState(directory);
		assert.equal(nonFinite.ok, false);
		assert.match(nonFinite.ok ? "" : nonFinite.reason, /finite/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("YES and NO entries and a sell can be reserved without a side cap", async () => {
	const directory = await freshDir();
	try {
		await initializeDisabledCandidate(directory, NOW);
		const loaded = await loadOlgaState(directory);
		assert.equal(loaded.ok, true);
		if (!loaded.ok) return;
		const yes = reserve(loaded.state.risk, order("yes-buy", "buy", "yes"));
		const no = reserve(yes, order("no-buy", "buy", "no"));
		const sold = reserve(no, order("yes-sell", "sell", "yes"));
		assert.equal(feeInclusiveHold(order("yes-buy")), "0.555000");
		assert.equal(sold.reservations[2]?.amount, "0.027500");
		assert.deepEqual(
			sold.reservations.map((item) => `${item.side}:${item.action}`),
			["yes:buy", "no:buy", "yes:sell"],
		);
		assert.throws(
			() => reserve(sold, order("yes-buy")),
			/duplicate in-flight id/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a successful tick stores the clock and exchange skew fails closed", async () => {
	const directory = await freshDir();
	try {
		await ready(directory);
		const first = await runDisabledTick(tick(directory, NOW + 50_000));
		assert.equal(first.action, "WAIT");
		const second = await runDisabledTick(tick(directory, NOW + 80_000));
		assert.equal(second.action, "WAIT");
		const clock = JSON.parse(
			await readFile(join(directory, "olga-clock.json"), "utf8"),
		) as { lastClockMs: number; lastExchangeMs: number };
		assert.equal(clock.lastClockMs, NOW + 80_000);
		assert.equal(clock.lastExchangeMs, NOW + 80_000);
		const missingDir = await freshDir();
		await ready(missingDir);
		const missing = await runDisabledTick({
			...tick(missingDir),
			exchangeNowMs: null,
		});
		assert.equal(missing.action, "STOP");
		assert.match(missing.reasons[0] ?? "", /Exchange clock is missing/);
		const skewDir = await freshDir();
		await ready(skewDir);
		const skewed = await runDisabledTick({
			...tick(skewDir),
			exchangeNowMs: NOW + 1_000 + 10_000,
		});
		assert.equal(skewed.action, "STOP");
		assert.match(skewed.reasons[0] ?? "", /Exchange clock skew/);
		await rm(missingDir, { recursive: true, force: true });
		await rm(skewDir, { recursive: true, force: true });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
