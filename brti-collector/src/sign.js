import crypto from "node:crypto";
import { halt } from "./errors.js";

export const ORIGIN = "https://external-api.kalshi.com";
export const KEYS_PATH = "/trade-api/v2/api_keys";
export const HISTORY_PATH = "/trade-api/v2/cfbenchmarks/history/values";
export const ALLOWED_PATHS = [KEYS_PATH, HISTORY_PATH];

export function preSignBytes(timestampMs, method, path) {
	if (method !== "GET") halt("method", "Only GET is allowed.");
	if (!ALLOWED_PATHS.includes(path)) halt("path", "Path is not on the collector allowlist.");
	if (path.includes("?") || path.includes("#")) {
		halt("path", "Signed path must not contain a query.");
	}
	if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
		halt("auth_timestamp", "Auth timestamp must be integer Unix milliseconds.");
	}
	return Buffer.from(`${timestampMs}GET${path}`, "utf8");
}

export function signGet(key, timestampMs, path) {
	const message = preSignBytes(timestampMs, "GET", path);
	const signature = crypto.sign(null, message, key).toString("base64");
	return { message, signature };
}

export function authHeaders(keyId, key, timestampMs, path) {
	const { signature } = signGet(key, timestampMs, path);
	return {
		"KALSHI-ACCESS-KEY": keyId,
		"KALSHI-ACCESS-TIMESTAMP": String(timestampMs),
		"KALSHI-ACCESS-SIGNATURE": signature,
	};
}

export function historyQuery(hourIso) {
	const params = new URLSearchParams();
	params.set("id", "BRTI");
	params.set("timespan", "HOUR");
	params.set("timestamp", hourIso);
	return params.toString();
}
