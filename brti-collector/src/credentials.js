import { normalizeEd25519Pem } from "./pem.js";
import { halt } from "./errors.js";

const ID_KEY = "KALSHI_BRTI_RO_KEY_ID";
const PEM_KEY = "KALSHI_BRTI_RO_PRIVATE_KEY";

export function readDedicatedCredentials(env) {
	const id = env[ID_KEY];
	const pem = env[PEM_KEY];
	if (typeof id !== "string" || id.trim() === "") {
		halt("missing_credentials", "Dedicated read-only key id is missing.");
	}
	if (typeof pem !== "string" || pem.trim() === "") {
		halt("missing_credentials", "Dedicated read-only private key is missing.");
	}
	const key = normalizeEd25519Pem(pem);
	return { keyId: id.trim(), key };
}
