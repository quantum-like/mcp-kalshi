import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { collectOneHour } from "../src/collect.js";
import { createFakeClock } from "../src/limiter.js";
import { commitHour, hourDirectory, DISK_FLOOR_BYTES, assertStorageRoot } from "../src/store.js";
import { BUILD, HOUR, HOUR_START, NOW, cleanRows, envelope, generateKey, metadata } from "./helpers.js";

const { pem } = generateKey();
const keyId = "dedicated-read-only-key";

function scriptFetch(rows = cleanRows()) {
	const calls = [];
	return {
		calls,
		fetchImpl: async (request) => {
			calls.push(request.url);
			if (request.url.includes("/api_keys")) {
				return { status: 200, body: Buffer.from(JSON.stringify(metadata(keyId))) };
			}
			return { status: 200, body: envelope(rows) };
		},
	};
}

async function runCollect(root, extra = {}) {
	const clock = createFakeClock(NOW);
	const transport = scriptFetch(extra.rows);
	const result = await collectOneHour({
		env: { KALSHI_BRTI_RO_KEY_ID: keyId, KALSHI_BRTI_RO_PRIVATE_KEY: pem },
		hourIso: HOUR,
		nowMs: NOW,
		clock,
		fetchImpl: transport.fetchImpl,
		root,
		attestation: { kind: "synthetic-test" },
		diskFreeBytes: DISK_FLOOR_BYTES,
		build: BUILD,
		...extra.options,
	});
	return { result, clock, calls: transport.calls };
}

test("a clean hour is stored once, not certified, and a repeat does not fetch", async () => {
	const root = await temp();
	const first = await runCollect(root);
	assert.equal(first.result.certification, "NOT_CERTIFIED");
	assert.equal(first.result.rawClean, true);
	assert.equal(first.calls.length, 2);
	assert.equal(first.clock.sleeps.some((ms) => ms >= 10_000), true);
	const directory = hourDirectory(root, HOUR);
	const provenance = await readFile(path.join(directory, "provenance.json"), "utf8");
	assert.equal(provenance.includes(keyId), false);
	assert.equal(provenance.includes("BEGIN"), false);
	assert.match(provenance, /NOT_CERTIFIED/);
	assert.match(provenance, /threshold_is_certification":false/);
	await assert.rejects(lstat(path.join(directory, "CERTIFIED.json")));
	const before = await readFile(path.join(directory, "response.json"));
	const second = await runCollect(root);
	assert.equal(second.result.status, "skipped");
	assert.equal(second.calls.length, 0);
	assert.deepEqual(await readFile(path.join(directory, "response.json")), before);
	const mode = (await lstat(path.join(directory, "response.json"))).mode & 0o777;
	assert.equal(mode, 0o600);
});

test("bad scope, unauthorized, low disk, and a bad host do not write an hour", async () => {
	const root = await temp();
	const clock = createFakeClock(NOW);
	let history = 0;
	await assert.rejects(
		collectOneHour({
			env: { KALSHI_BRTI_RO_KEY_ID: keyId, KALSHI_BRTI_RO_PRIVATE_KEY: pem },
			hourIso: HOUR,
			nowMs: NOW,
			clock,
			root,
			attestation: { kind: "synthetic-test" },
			diskFreeBytes: DISK_FLOOR_BYTES,
			build: BUILD,
			fetchImpl: async (request) => {
				if (request.url.includes("history")) history += 1;
				return { status: 200, body: Buffer.from(JSON.stringify(metadata(keyId, ["write"]))) };
			},
		}),
		/metadata/,
	);
	assert.equal(history, 0);
	await assert.rejects(lstat(hourDirectory(root, HOUR)));
	await assert.rejects(
		collectOneHour({
			env: { KALSHI_BRTI_RO_KEY_ID: keyId, KALSHI_BRTI_RO_PRIVATE_KEY: pem },
			hourIso: HOUR,
			nowMs: NOW,
			clock: createFakeClock(NOW),
			root,
			attestation: { kind: "synthetic-test" },
			diskFreeBytes: DISK_FLOOR_BYTES,
			build: BUILD,
			fetchImpl: async () => ({ status: 401, body: Buffer.from('{"detail":"unauthorized"}') }),
		}),
		/unauthorized/,
	);
	await assert.rejects(
		collectOneHour({
			env: { KALSHI_BRTI_RO_KEY_ID: keyId, KALSHI_BRTI_RO_PRIVATE_KEY: pem },
			hourIso: HOUR,
			nowMs: NOW,
			clock: createFakeClock(NOW),
			root,
			attestation: { kind: "synthetic-test" },
			diskFreeBytes: 1,
			build: BUILD,
			fetchImpl: async () => {
				throw new Error("should not fetch");
			},
		}),
		/disk/,
	);
	await assert.rejects(
		assertStorageRoot(root, { kind: "box" }, DISK_FLOOR_BYTES),
		/storage_host/,
	);
	await assert.rejects(
		assertStorageRoot(root, { kind: "olga-local", affirmed: true }, DISK_FLOOR_BYTES),
		/storage_host/,
	);
});

test("symlink roots, no-clobber, hash mismatch, and crash boundaries leave prior bytes", async () => {
	const root = await temp();
	const link = path.join(root, "linked");
	const other = await temp();
	await symlink(other, link);
	await assert.rejects(assertStorageRoot(link, { kind: "synthetic-test" }, DISK_FLOOR_BYTES), /symlink/);
	const provenance = {
		certification: "NOT_CERTIFIED",
		threshold_is_certification: false,
		response_sha256: "",
	};
	const bytes = Buffer.from('{"data":{"serverTime":"t","payload":[]}}\n');
	const stored = await commitHour({
		root,
		iso: HOUR,
		responseBytes: bytes,
		provenance,
		diskFreeBytes: DISK_FLOOR_BYTES,
		attestation: { kind: "synthetic-test" },
	});
	assert.equal(stored.status, "stored");
	const response = path.join(hourDirectory(root, HOUR), "response.json");
	const original = await readFile(response);
	await assert.rejects(
		commitHour({
			root,
			iso: HOUR,
			responseBytes: Buffer.from("other"),
			provenance,
			diskFreeBytes: DISK_FLOOR_BYTES,
			attestation: { kind: "synthetic-test" },
		}),
		/integrity_incident/,
	);
	assert.deepEqual(await readFile(response), original);
	for (const point of ["after-staging", "after-final-dir"]) {
		const crashRoot = await temp();
		await assert.rejects(
			commitHour({
				root: crashRoot,
				iso: HOUR,
				responseBytes: bytes,
				provenance,
				crashBefore: point,
				diskFreeBytes: DISK_FLOOR_BYTES,
				attestation: { kind: "synthetic-test" },
			}),
			/crash_injected/,
		);
		await assert.rejects(lstat(path.join(hourDirectory(crashRoot, HOUR), "COMPLETE.json")));
	}
	const crashRoot = await temp();
	await assert.rejects(
		commitHour({
			root: crashRoot,
			iso: HOUR,
			responseBytes: bytes,
			provenance,
			crashBefore: "after-link",
			diskFreeBytes: DISK_FLOOR_BYTES,
			attestation: { kind: "synthetic-test" },
		}),
		/crash_injected/,
	);
	const partial = await readFile(path.join(hourDirectory(crashRoot, HOUR), "response.json"));
	await assert.rejects(
		commitHour({
			root: crashRoot,
			iso: HOUR,
			responseBytes: Buffer.from("changed"),
			provenance,
			diskFreeBytes: DISK_FLOOR_BYTES,
			attestation: { kind: "synthetic-test" },
		}),
		/partial_hour/,
	);
	assert.deepEqual(await readFile(path.join(hourDirectory(crashRoot, HOUR), "response.json")), partial);
	await assert.rejects(lstat(path.join(hourDirectory(crashRoot, HOUR), "COMPLETE.json")));
	assert.equal(HOUR_START > 0, true);
});

test("a second process cannot take the collector lock", async () => {
	const root = await temp();
	const holder = path.join(root, "hold.mjs");
	const moduleUrl = new URL("../src/store.js", import.meta.url).href;
	await writeFile(
		holder,
		`import { acquireCollectorLock } from ${JSON.stringify(moduleUrl)};\nconst lock = acquireCollectorLock(process.argv[2]);\nprocess.stdout.write("held\\n");\nsetInterval(() => lock, 1000);\n`,
	);
	const child = spawn(process.execPath, [holder, root], { stdio: ["ignore", "pipe", "pipe"] });
	let seen = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		seen += chunk;
	});
	const started = Date.now();
	while (!seen.includes("held")) {
		if (child.exitCode !== null || Date.now() - started > 5_000) {
			throw new Error(`holder did not lock: ${seen}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	await assert.rejects(
		commitHour({
			root,
			iso: HOUR,
			responseBytes: Buffer.from("x"),
			provenance: { certification: "NOT_CERTIFIED" },
			diskFreeBytes: DISK_FLOOR_BYTES,
			attestation: { kind: "synthetic-test" },
		}),
		/lock_held/,
	);
	child.kill("SIGKILL");
	await once(child, "exit");
});

async function temp() {
	const { tempRoot } = await import("./helpers.js");
	return tempRoot();
}
