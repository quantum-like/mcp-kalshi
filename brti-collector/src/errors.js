const PEM_BLOCK = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;
const LONG_SECRET = /[A-Za-z0-9+/=]{40,}/g;

export class CollectorHalt extends Error {
	constructor(code, detail = "") {
		const safeDetail = sanitize(detail);
		super(safeDetail ? `${code}: ${safeDetail}` : code);
		this.name = "CollectorHalt";
		this.code = code;
		this.detail = safeDetail;
	}
}

export function sanitize(value, secrets = []) {
	let text = String(value ?? "")
		.replace(PEM_BLOCK, "[redacted-pem]")
		.replace(/KALSHI-ACCESS-[A-Z-]+\s*[:=]\s*\S+/gi, "[redacted-header]");
	for (const secret of secrets) {
		if (typeof secret === "string" && secret.length >= 6) text = text.replaceAll(secret, "[redacted]");
	}
	return text.replace(LONG_SECRET, "[redacted]").slice(0, 240);
}

export function halt(code, detail) {
	throw new CollectorHalt(code, detail);
}
