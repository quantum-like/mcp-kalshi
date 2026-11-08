import { sanitize, halt } from "./errors.js";
import { ORIGIN, authHeaders, historyQuery, HISTORY_PATH, KEYS_PATH } from "./sign.js";

export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const CONNECT_TIMEOUT_MS = 5_000;
export const TOTAL_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = [30_000, 60_000];
export const RETRY_AFTER_CEILING_MS = 300_000;

const DENIAL = [
	/entitlement/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/not authorized/i,
	/access denied/i,
	/authorization/i,
];

export function explicitDenial(detail) {
	return DENIAL.some((pattern) => pattern.test(detail));
}

export function classifyStatus(status, detail) {
	if (status === 401 || status === 403) return { action: "halt", code: "unauthorized" };
	if ((status === 400 || status === 503) && explicitDenial(detail)) {
		return { action: "halt", code: "entitlement_denied" };
	}
	if (status === 400 || status === 404) return { action: "halt", code: "parameter_rejected" };
	if (status >= 300 && status < 400) return { action: "halt", code: "redirect_rejected" };
	if (status === 429 || (status >= 500 && status <= 599)) return { action: "retry", code: "transient" };
	if (status === 200) return { action: "ok", code: "ok" };
	return { action: "halt", code: "unexpected_status" };
}

export function allowlistedUrl(path, query = "") {
	if (path !== KEYS_PATH && path !== HISTORY_PATH) halt("path", "Path is not allowlisted.");
	const url = new URL(ORIGIN + path);
	if (url.origin !== ORIGIN || url.protocol !== "https:" || url.pathname !== path) {
		halt("origin", "Origin is not the production external API.");
	}
	if (query) url.search = `?${query}`;
	return url;
}

function shortDetail(payload) {
	if (typeof payload !== "object" || payload === null) return "";
	const candidates = [payload.detail, payload.message, payload.error?.code, payload.error?.message];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 200) {
			return sanitize(candidate);
		}
	}
	return "";
}

function retryWaitMs(attemptIndex, retryAfterMs, jitterMs) {
	const base = BACKOFF_MS[attemptIndex - 1] ?? RETRY_AFTER_CEILING_MS;
	const requested = Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
	const wait = Math.max(base, requested) + Math.max(0, jitterMs);
	if (wait > RETRY_AFTER_CEILING_MS) {
		halt("retry_ceiling", "Required wait exceeds 300 seconds. Halting the finite run.");
	}
	return wait;
}

export function createKalshiClient({ credentials, clock, limiter, fetchImpl, jitter = () => 0 }) {
	async function once(path, query) {
		const started = await limiter.acquire();
		const authMs = clock.now();
		const headers = authHeaders(credentials.keyId, credentials.key, authMs, path);
		const url = allowlistedUrl(path, query);
		let response;
		try {
			response = await fetchImpl({
				url: url.toString(),
				method: "GET",
				headers,
				redirect: "error",
				connectTimeoutMs: CONNECT_TIMEOUT_MS,
				totalTimeoutMs: TOTAL_TIMEOUT_MS,
			});
		} catch (error) {
			return {
				started,
				authMs,
				retry: true,
				code: "network",
				detail: sanitize(error instanceof Error ? error.message : "network"),
			};
		}
		if (response?.redirected || (response?.status >= 300 && response?.status < 400)) {
			halt("redirect_rejected", "Redirects are refused.");
		}
		const bytes = Buffer.from(response?.body ?? []);
		if (bytes.length > MAX_BODY_BYTES) halt("body_limit", "Response exceeds 10 MiB.");
		let parsed = null;
		let detail = "";
		if (bytes.length > 0) {
			try {
				parsed = JSON.parse(bytes.toString("utf8"));
				detail = shortDetail(parsed);
			} catch {
				parsed = null;
			}
		}
		const decision = classifyStatus(response.status, detail);
		if (decision.action === "halt") halt(decision.code, detail || decision.code);
		return {
			started,
			authMs,
			retry: decision.action === "retry",
			code: decision.code,
			detail,
			status: response.status,
			bytes,
			parsed,
			retryAfterMs: response.retryAfterMs,
		};
	}

	async function request(path, query = "") {
		const attempts = [];
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			const result = await once(path, query);
			attempts.push({
				attempt,
				authMs: result.authMs,
				status: result.status ?? null,
				code: result.code,
			});
			if (!result.retry) return { ...result, attempts };
			if (attempt === MAX_ATTEMPTS) {
				halt("hour_missing", "Transient failures exhausted the attempt budget.");
			}
			const wait = retryWaitMs(attempt, result.retryAfterMs, jitter(attempt));
			await clock.sleep(wait);
		}
		halt("hour_missing", "Attempt budget exhausted.");
	}

	return {
		keys: () => request(KEYS_PATH),
		history: (hourIso) => request(HISTORY_PATH, historyQuery(hourIso)),
	};
}
