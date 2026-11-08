import assert from "node:assert/strict";
import { readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createRedactor } from "../src/errors.js";
import { createKalshiClient } from "../src/transport.js";
import { createFakeClock } from "../src/limiter.js";
import { collectOneHour } from "../src/collect.js";
import { hourDirectory, DISK_FLOOR_BYTES } from "../src/store.js";
import { readDedicatedCredentials } from "../src/credentials.js";
import { BUILD, HOUR, NOW, cleanRows, envelope, generateKey, metadata, tempRoot } from "./helpers.js";

const SHORT_ID = "k9";
const UUID_ID = "123e4567-e89b-12d3-a456-426614174000";

function forms(secret) {
	return [
		secret,
		encodeURIComponent(secret),
		encodeURIComponent(encodeURIComponent(secret)),
		Buffer.from(secret, "utf8").toString("base64"),
		Buffer.from(secret, "utf8").toString("base64url"),
	];
}

function assertHidden(text, secret) {
	for (const form of forms(secret)) assert.equal(text.includes(form), false);
}

test("short ids, UUID ids, encodings, nested errors, and transport exceptions are redacted", async () => {
	const { pem } = generateKey();
	for (const keyId of [SHORT_ID, UUID_ID]) {
		const credentials = readDedicatedCredentials({
			KALSHI_BRTI_RO_KEY_ID: keyId,
			KALSHI_BRTI_RO_PRIVATE_KEY: pem,
		});
		const encoded = encodeURIComponent(keyId);
		const nested = new Error(`provider rejected ${keyId}`);
		nested.cause = new Error(`see ${encoded}`);
		nested.errors = [{ url: `https://external-api.kalshi.com/trade-api/v2/api_keys?id=${encoded}` }];
		const clock = createFakeClock(NOW);
		const thrown = Object.assign(nested, {
			body: { error: { message: Buffer.from(keyId).toString("base64") } },
		});
		const networkClient = createKalshiClient({
			credentials,
			clock,
			limiter: { async acquire() { return clock.now(); } },
			fetchImpl: async () => {
				throw thrown;
			},
		});
		const network = await networkClient.keys().catch((error) => error);
		assert.equal(network.code, "hour_missing");
		assertHidden(`${network.message}\n${network.detail}\n${network.stack}`, keyId);
		const denied = createKalshiClient({
			credentials,
			clock,
			limiter: { async acquire() { return clock.now(); } },
			fetchImpl: async () => ({
				status: 401,
				body: Buffer.from(JSON.stringify({
					detail: `unknown key ${keyId}`,
					error: { message: encoded, cause: { note: Buffer.from(keyId).toString("base64") } },
				})),
			}),
		});
		const halted = await denied.keys().catch((error) => error);
		assert.equal(halted.code, "unauthorized");
		assertHidden(`${halted.message}\n${halted.detail}\n${halted.stack}`, keyId);
	}
	const redacted = createRedactor([SHORT_ID]).text(`id ${SHORT_ID} url ${encodeURIComponent(SHORT_ID)}`);
	assertHidden(redacted, SHORT_ID);
});

test("restart fail-closes on a deduped or provenance mismatch and does not repair", async () => {
	const { pem } = generateKey();
	const keyId = "dedicated-read-only-key";
	const root = await tempRoot();
	const clock = createFakeClock(NOW);
	let calls = 0;
	const run = () => collectOneHour({
		env: { KALSHI_BRTI_RO_KEY_ID: keyId, KALSHI_BRTI_RO_PRIVATE_KEY: pem },
		hourIso: HOUR,
		nowMs: NOW,
		clock,
		root,
		attestation: { kind: "synthetic-test" },
		diskFreeBytes: DISK_FLOOR_BYTES,
		build: BUILD,
		fetchImpl: async (request) => {
			calls += 1;
			if (request.url.includes("/api_keys")) {
				return { status: 200, body: Buffer.from(JSON.stringify(metadata(keyId))) };
			}
			return { status: 200, body: envelope(cleanRows()) };
		},
	});
	const stored = await run();
	assert.equal(stored.certification, "NOT_CERTIFIED");
	const directory = hourDirectory(root, HOUR);
	const dedupedPath = path.join(directory, "deduped.json");
	const provenancePath = path.join(directory, "provenance.json");
	const completePath = path.join(directory, "COMPLETE.json");
	const responsePath = path.join(directory, "response.json");
	const beforeDeduped = await readFile(dedupedPath);
	const beforeProvenance = await readFile(provenancePath);
	const beforeComplete = await readFile(completePath);
	const beforeResponse = await readFile(responsePath);
	const flipped = Buffer.from(beforeDeduped);
	flipped[0] ^= 1;
	await writeFile(dedupedPath, flipped);
	calls = 0;
	await assert.rejects(run(), /integrity_incident/);
	assert.equal(calls, 0);
	assert.deepEqual(await readFile(dedupedPath), flipped);
	assert.deepEqual(await readFile(completePath), beforeComplete);
	assert.deepEqual(await readFile(responsePath), beforeResponse);
	await assert.rejects(lstat(path.join(directory, "CERTIFIED.json")));
	await writeFile(dedupedPath, beforeDeduped);
	const flippedProvenance = Buffer.from(beforeProvenance);
	flippedProvenance[flippedProvenance.length - 3] ^= 1;
	await writeFile(provenancePath, flippedProvenance);
	calls = 0;
	await assert.rejects(run(), /integrity_incident/);
	assert.equal(calls, 0);
	assert.deepEqual(await readFile(provenancePath), flippedProvenance);
	assert.equal(JSON.parse(beforeComplete.toString("utf8")).certification, "NOT_CERTIFIED");
});
