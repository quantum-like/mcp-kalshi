import crypto from "node:crypto";
import { mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HOUR_MS, TICK_MS } from "../src/hour.js";
import { EXPECTED_ROWS } from "../src/certify.js";

export function generateKey() {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	return { privateKey, publicKey, pem };
}

export function flatten(pem) {
	return pem.replaceAll("\n", "");
}

export function escapeNewlines(pem) {
	return pem.replaceAll("\n", "\\n");
}

export async function tempRoot() {
	const root = await mkdtemp(path.join(tmpdir(), "brti-collector-"));
	await chmod(root, 0o700);
	return root;
}

export const HOUR = "2026-11-07T23:00:00.000Z";
export const HOUR_START = Date.parse(HOUR);
export const NOW = HOUR_START + HOUR_MS + 120_000;

export function envelope(rows, serverTime = "2026-11-07T23:00:01.000Z") {
	return Buffer.from(JSON.stringify({ data: { serverTime, payload: rows } }));
}

export function cleanRows(start = HOUR_START) {
	const rows = [];
	for (let index = 0; index < EXPECTED_ROWS; index += 1) {
		const price = (75000 + (index % 20) / 100).toFixed(2);
		rows.push({ time: start + index * TICK_MS, value: price });
	}
	return rows;
}

export function metadata(id, scopes = ["read"], keyType = "ed25519") {
	return { api_keys: [{ api_key_id: id, name: "ro", key_type: keyType, scopes }] };
}

export const BUILD = { commit: "test-commit", bundleSha256: "a".repeat(64) };
