import crypto from "node:crypto";
import { halt } from "./errors.js";

export function normalizeEd25519Pem(input) {
	if (typeof input !== "string" || input.trim() === "") {
		halt("malformed_pem", "Private key PEM is empty.");
	}
	let text = input.trim();
	if (text.includes("\\n")) text = text.replaceAll("\\n", "\n");
	const begins = text.match(/-----BEGIN [^-]+-----/g) ?? [];
	const ends = text.match(/-----END [^-]+-----/g) ?? [];
	if (begins.length !== 1 || ends.length !== 1) {
		halt("malformed_pem", "PEM must contain exactly one block.");
	}
	if (!text.includes("\n")) {
		const begin = text.match(/^(-----BEGIN [^-]+-----)/);
		const end = text.match(/(-----END [^-]+-----)$/);
		if (!begin || !end) halt("malformed_pem", "Flattened PEM envelope is unreadable.");
		const body = text.slice(begin[1].length, text.length - end[1].length).replaceAll(/\s+/g, "");
		const wrapped = body.match(/.{1,64}/g)?.join("\n");
		if (!wrapped) halt("malformed_pem", "Flattened PEM body is empty.");
		text = `${begin[1]}\n${wrapped}\n${end[1]}\n`;
	}
	let key;
	try {
		key = crypto.createPrivateKey({ key: text, format: "pem" });
	} catch {
		halt("malformed_pem", "Private key PEM did not parse.");
	}
	if (key.asymmetricKeyType !== "ed25519") {
		halt("key_type", "Parsed private key is not Ed25519.");
	}
	return key;
}
