const PEM_BLOCK = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;
const LONG_SECRET = /[A-Za-z0-9+/=_-]{40,}/g;

export class CollectorHalt extends Error {
	constructor(code, detail = "") {
		const safeDetail = sanitize(detail);
		super(safeDetail ? `${code}: ${safeDetail}` : code);
		this.name = "CollectorHalt";
		this.code = code;
		this.detail = safeDetail;
	}
}

function encodings(secret) {
	const forms = new Set([secret, secret.toLowerCase(), secret.toUpperCase()]);
	forms.add(encodeURIComponent(secret));
	forms.add(encodeURIComponent(encodeURIComponent(secret)));
	forms.add(Buffer.from(secret, "utf8").toString("base64"));
	forms.add(Buffer.from(secret, "utf8").toString("base64url"));
	forms.add(JSON.stringify(secret).slice(1, -1));
	return [...forms].filter((form) => form.length > 0);
}

export function createRedactor(secrets = []) {
	const needles = [];
	for (const secret of secrets) {
		if (typeof secret !== "string" || secret.length === 0) continue;
		needles.push(...encodings(secret));
	}
	const unique = [...new Set(needles)].sort((left, right) => right.length - left.length);
	return {
		text(value) {
			let text = String(value ?? "")
				.replace(PEM_BLOCK, "[redacted-pem]")
				.replace(/KALSHI-ACCESS-[A-Z-]+\s*[:=]\s*\S+/gi, "[redacted-header]");
			for (const needle of unique) text = text.split(needle).join("[redacted]");
			return text.replace(LONG_SECRET, "[redacted]").slice(0, 240);
		},
		error(error) {
			return this.text(collectErrorText(error));
		},
	};
}

function collectErrorText(error) {
	const parts = [];
	const seen = new Set();
	function walk(value, depth) {
		if (value == null || depth > 8) return;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			parts.push(String(value));
			return;
		}
		if (typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (value instanceof Error) {
			parts.push(value.name, value.message);
			if (value.detail) walk(value.detail, depth + 1);
			if (value.url) walk(value.url, depth + 1);
			if (value.body) walk(value.body, depth + 1);
			if (value.cause) walk(value.cause, depth + 1);
			if (Array.isArray(value.errors)) {
				for (const nested of value.errors) walk(nested, depth + 1);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const nested of value) walk(nested, depth + 1);
			return;
		}
		for (const nested of Object.values(value)) walk(nested, depth + 1);
	}
	walk(error, 0);
	return parts.join(" ");
}

export function sanitize(value, secrets = []) {
	return createRedactor(secrets).text(value);
}

export function halt(code, detail) {
	throw new CollectorHalt(code, detail);
}
