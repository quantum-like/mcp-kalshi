import { halt } from "./errors.js";

export function attestReadScope(body, keyId, checkedAt) {
	if (typeof body !== "object" || body === null || !Array.isArray(body.api_keys)) {
		halt("metadata", "API key metadata is unreadable.");
	}
	const matches = body.api_keys.filter((row) => row?.api_key_id === keyId);
	if (matches.length !== 1) halt("metadata", "Dedicated key id did not match exactly one row.");
	const row = matches[0];
	if (row.key_type !== "ed25519") halt("metadata", "Metadata key type is not ed25519.");
	if (!Array.isArray(row.scopes)) halt("metadata", "Metadata scopes are missing.");
	const unique = new Set(row.scopes);
	if (unique.size !== row.scopes.length || unique.size !== 1 || !unique.has("read")) {
		halt("metadata", "Scope is not exactly read.");
	}
	return {
		scope_verified: true,
		scopes: ["read"],
		key_type: "ed25519",
		checked_at: checkedAt,
		metadata_status: 200,
	};
}
