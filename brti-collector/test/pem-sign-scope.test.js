import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { readDedicatedCredentials } from "../src/credentials.js";
import { sanitize } from "../src/errors.js";
import { normalizeEd25519Pem } from "../src/pem.js";
import { attestReadScope } from "../src/scope.js";
import { authHeaders, historyQuery, preSignBytes, HISTORY_PATH, KEYS_PATH } from "../src/sign.js";
import { assertHourAligned, pacificLabel } from "../src/hour.js";
import { escapeNewlines, flatten, generateKey, HOUR, HOUR_START, metadata } from "./helpers.js";

const { pem, publicKey } = generateKey();
const keyId = "dedicated-read-only-key";

test("dedicated credentials accept newlines, escapes, and a flattened PKCS8 envelope", () => {
	const direct = readDedicatedCredentials({
		KALSHI_BRTI_RO_KEY_ID: keyId,
		KALSHI_BRTI_RO_PRIVATE_KEY: pem,
	});
	const escaped = normalizeEd25519Pem(escapeNewlines(pem));
	const flat = normalizeEd25519Pem(flatten(pem));
	const pub = (key) =>
		(key.type === "public" ? key : crypto.createPublicKey(key))
			.export({ type: "spki", format: "der" })
			.toString("hex");
	assert.equal(pub(direct.key), pub(publicKey));
	assert.equal(pub(escaped), pub(publicKey));
	assert.equal(pub(flat), pub(publicKey));
});

test("missing env, malformed PEM, multiple blocks, and RSA halt", () => {
	assert.throws(() => readDedicatedCredentials({}), /missing_credentials/);
	assert.throws(
		() => readDedicatedCredentials({ KALSHI_BRTI_RO_KEY_ID: " ", KALSHI_BRTI_RO_PRIVATE_KEY: pem }),
		/missing_credentials/,
	);
	assert.throws(() => normalizeEd25519Pem(`${pem}${pem}`), /malformed_pem/);
	const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
	const rsaPem = rsa.export({ type: "pkcs8", format: "pem" }).toString();
	assert.throws(() => normalizeEd25519Pem(rsaPem), /key_type/);
});

test("credential lookup does not inspect other environment names", () => {
	const env = new Proxy(
		{ KALSHI_BRTI_RO_KEY_ID: keyId, KALSHI_BRTI_RO_PRIVATE_KEY: pem },
		{
			get(target, prop) {
				if (prop !== "KALSHI_BRTI_RO_KEY_ID" && prop !== "KALSHI_BRTI_RO_PRIVATE_KEY") {
					throw new Error(`inspected ${String(prop)}`);
				}
				return target[prop];
			},
		},
	);
	assert.equal(readDedicatedCredentials(env).keyId, keyId);
});

test("errors redact PEM blocks and do not echo the key id", () => {
	const leaked = `${pem} id=${keyId} KALSHI-ACCESS-SIGNATURE: abcdefghijklmnopqrstuvwxyz0123456789ABCD`;
	const safe = sanitize(leaked, [keyId]);
	assert.equal(safe.includes("BEGIN"), false);
	assert.equal(safe.includes(keyId), false);
	assert.equal(safe.includes("abcdefghijklmnopqrstuvwxyz0123456789ABCD"), false);
});

test("pre-sign bytes exclude the query and use auth milliseconds, not the hour", () => {
	const authMs = HOUR_START + 4_000_000;
	const message = preSignBytes(authMs, "GET", HISTORY_PATH);
	assert.equal(message.toString("utf8"), `${authMs}GET${HISTORY_PATH}`);
	assert.equal(message.includes("?"), false);
	assert.equal(message.includes("BRTI"), false);
	const query = historyQuery(HOUR);
	assert.equal(query.includes("id=BRTI"), true);
	assert.equal(query.includes("timespan=HOUR"), true);
	assert.equal(query.includes(encodeURIComponent(HOUR)), true);
	assert.throws(() => preSignBytes(authMs, "POST", HISTORY_PATH), /method/);
	assert.throws(() => preSignBytes(authMs, "GET", "/trade-api/v2/portfolio/orders"), /path/);
	const headers = authHeaders(
		keyId,
		normalizeEd25519Pem(pem),
		authMs,
		KEYS_PATH,
	);
	assert.equal(headers["KALSHI-ACCESS-TIMESTAMP"], String(authMs));
	assert.notEqual(headers["KALSHI-ACCESS-TIMESTAMP"], String(HOUR_START));
	const verified = crypto.verify(
		null,
		Buffer.from(`${authMs}GET${KEYS_PATH}`),
		publicKey,
		Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64"),
	);
	assert.equal(verified, true);
	assert.equal(assertHourAligned(HOUR), HOUR_START);
	assert.throws(() => assertHourAligned("2026-11-07T23:15:00.000Z"), /hour_alignment/);
	assert.match(pacificLabel(HOUR_START), /PST/);
});

test("metadata scope must be exactly read and ed25519", () => {
	assert.equal(attestReadScope(metadata(keyId), keyId, "t").scope_verified, true);
	for (const body of [
		metadata(keyId, ["write"]),
		metadata(keyId, ["read", "write"]),
		metadata(keyId, ["read", "unknown"]),
		metadata(keyId, ["read", "read"]),
		metadata(keyId, []),
		metadata(keyId, ["read"], "rsa"),
		{ api_keys: [] },
		{ api_keys: [metadata(keyId).api_keys[0], metadata(keyId).api_keys[0]] },
		{ api_keys: [{ api_key_id: "other", key_type: "ed25519", scopes: ["read"] }] },
	]) {
		assert.throws(() => attestReadScope(body, keyId, "t"), /metadata/);
	}
});
