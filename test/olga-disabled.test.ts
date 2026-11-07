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
import { MAX_AWAKE_GAP_MS, decideOlga } from "../src/olga/decide.js";
import { acquireHostLock } from "../src/olga/lock.js";
import {
	OLGA_HOST_ID,
	RISK_CAP,
	SEALED_POLICY_IDS,
	initializeDisabledCandidate,
	loadOlgaState,
	markSubmitting,
	markUnknown,
	rejectProfitOrTopUp,
	releaseUnsent,
	reserve,
	saveBinding,
	saveRisk,
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

test("the $5 total cap rejects another cent, profit, and a rewritten cap", async () => {
	const directory = await freshDir();
	try {
		await initializeDisabledCandidate(directory, NOW);
		let loaded = await loadOlgaState(directory);
		assert.equal(loaded.ok, true);
		if (!loaded.ok) return;
		const reserved = reserve(loaded.state.risk, "5.000000", "cap-1");
		await saveRisk(directory, reserved);
		loaded = await loadOlgaState(directory);
		assert.equal(loaded.ok, true);
		if (!loaded.ok) return;
		assert.equal(loaded.state.risk.cap, RISK_CAP);
		assert.equal(loaded.state.risk.allocated, "5.000000");
		assert.throws(
			() => reserve(loaded.state.risk, "0.000001", "cap-2"),
			/immutable \$5/,
		);
		assert.throws(() => rejectProfitOrTopUp(), /cannot raise or reset/);
		const raw = JSON.parse(
			await readFile(join(directory, "olga-risk.json"), "utf8"),
		) as { cap: string; profit?: string };
		raw.cap = "6.000000";
		await writeFile(join(directory, "olga-risk.json"), JSON.stringify(raw));
		const tampered = await loadOlgaState(directory);
		assert.equal(tampered.ok, false);
		assert.match(tampered.ok ? "" : tampered.reason, /immutable 5\.000000/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a1 account binding rejects a2, a different member, and an incomplete read", async () => {
	const directory = await freshDir();
	try {
		await ready(directory);
		const base = {
			directory,
			nowMs: NOW + 1_000,
			feedAtMs: NOW + 1_000,
			observed: observedBound(),
		};
		const a2 = await runDisabledTick({ ...base, profile: "a2" });
		assert.equal(a2.action, "STOP");
		assert.match(a2.reasons[0] ?? "", /a2 profile/);
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
		await saveRisk(
			directory,
			reserve(first.state.risk, "1.250000", "durable-1"),
		);
		const second = await loadOlgaState(directory);
		assert.equal(second.ok, true);
		if (!second.ok) return;
		assert.equal(second.state.risk.allocated, "1.250000");
		assert.equal(second.state.risk.reservations[0]?.state, "held");
		assert.equal(second.state.risk.cap, "5.000000");
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
		const held = reserve(loaded.state.risk, "0.500000", "unknown-1");
		await saveRisk(directory, markUnknown(held, "unknown-1"));
		const input = {
			directory,
			nowMs: NOW + 1_000,
			feedAtMs: NOW + 1_000,
			observed: observedBound(),
		};
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
			() => reserve(after.state.risk, "0.100000", "unknown-2"),
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
		const held = reserve(loaded.state.risk, "0.400000", "orphan-1");
		await saveRisk(directory, markSubmitting(held, "orphan-1"));
		const decision = await runDisabledTick({
			directory,
			nowMs: NOW + 1_000,
			feedAtMs: NOW + 1_000,
			observed: observedBound(),
		});
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
				hostId: "other-mac",
				profile: "a1",
				fallback: "auto",
			}),
		);
		const decision = await runDisabledTick({
			directory,
			nowMs: NOW + 1_000,
			feedAtMs: NOW + 1_000,
			observed: observedBound(),
		});
		assert.equal(decision.action, "STOP");
		assert.match(decision.reasons[0] ?? "", /No automatic fallback/);
		const owner = await readFile(join(directory, "olga-owner.json"), "utf8");
		assert.match(owner, /other-mac/);
		assert.equal(OLGA_HOST_ID, "olga");
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
				directory,
				nowMs: NOW + 1_000,
				feedAtMs: NOW + 1_000,
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
		const input = {
			directory,
			nowMs: NOW + 1_000,
			feedAtMs: NOW + 1_000,
			observed: observedBound(),
		};
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
			directory: staleDirectory,
			nowMs: NOW + 1_000,
			feedAtMs: NOW - 20_000,
			observed: observedBound(),
		});
		assert.equal(stale.action, "STOP");
		assert.match(stale.reasons[0] ?? "", /Market feed is stale/);
		await ready(directory);
		const slept = await runDisabledTick({
			directory,
			nowMs: NOW + MAX_AWAKE_GAP_MS + 1,
			feedAtMs: NOW + MAX_AWAKE_GAP_MS + 1,
			observed: observedBound(),
		});
		assert.equal(slept.action, "STOP");
		assert.match(slept.reasons[0] ?? "", /No catch-up/);
		const later = await runDisabledTick({
			directory,
			nowMs: NOW + MAX_AWAKE_GAP_MS + 2_000,
			feedAtMs: NOW + MAX_AWAKE_GAP_MS + 2_000,
			observed: observedBound(),
		});
		assert.match(later.reasons[0] ?? "", /No catch-up/);
		await unlink(join(directory, "olga-risk.json"));
		const partial = await runDisabledTick({
			directory,
			nowMs: NOW + 1_000,
			feedAtMs: NOW + 1_000,
			observed: observedBound(),
		});
		assert.match(partial.reasons[0] ?? "", /replenish/);
		const names = await readdir(directory);
		assert.equal(names.includes("olga-risk.json"), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
		await rm(staleDirectory, { recursive: true, force: true });
	}
});
