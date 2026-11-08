import { readDedicatedCredentials } from "./credentials.js";
import { attestReadScope } from "./scope.js";
import { createKalshiClient } from "./transport.js";
import { assertCompletedHour } from "./hour.js";
import { certifyRows, parseHistory, buildProvenance, sha256 } from "./certify.js";
import { compareCoinbase } from "./coinbase.js";
import { commitHour, inspectHour, assertStorageRoot } from "./store.js";
import { createLimiter } from "./limiter.js";
import { halt } from "./errors.js";

export async function collectOneHour({
	env,
	hourIso,
	nowMs,
	clock,
	fetchImpl,
	root,
	attestation,
	diskFreeBytes,
	build,
	coinbaseSamples = null,
	coinbaseSourceKind = "unspecified",
	jitter,
	lagMs,
}) {
	if (!build?.commit || !build?.bundleSha256) {
		halt("build", "Collector commit and bundle hash are required in provenance.");
	}
	const hour = assertCompletedHour(hourIso, nowMs, lagMs);
	await assertStorageRoot(root, attestation, diskFreeBytes);
	let existing;
	try {
		existing = await inspectHour(root, hour.iso);
	} catch (error) {
		throw error;
	}
	if (existing.status === "match") return { status: "skipped", httpRequests: 0, directory: existing.directory };
	const credentials = readDedicatedCredentials(env);
	const limiter = createLimiter(clock);
	const client = createKalshiClient({ credentials, clock, limiter, fetchImpl, jitter });
	const metadata = await client.keys();
	const attestationResult = attestReadScope(metadata.parsed, credentials.keyId, new Date(clock.now()).toISOString());
	const history = await client.history(hour.iso);
	const parsed = parseHistory(history.parsed);
	const comparison = compareCoinbase({
		samples: coinbaseSamples,
		rows: parsed.rows,
		startMs: hour.startMs,
		endMs: hour.endMs,
		sourceKind: coinbaseSourceKind,
	});
	const report = certifyRows(parsed.rows, hour.startMs, comparison);
	const provenance = buildProvenance({
		hour,
		fetchedAtMs: clock.now(),
		status: history.status,
		attempts: history.attempts,
		bytes: history.bytes,
		report,
		attestation: attestationResult,
		build,
	});
	if (provenance.threshold_is_certification !== false) {
		halt("certification", "Provisional thresholds cannot certify an hour.");
	}
	const stored = await commitHour({
		root,
		iso: hour.iso,
		responseBytes: history.bytes,
		provenance,
		dedupedBytes: Buffer.from(`${JSON.stringify({ raw_sha256: sha256(history.bytes), rows: report.deduped })}\n`),
		rejectedBytes: report.rawClean
			? null
			: Buffer.from(`${JSON.stringify({ certification: "REJECTED", reasons: report.reasons })}\n`),
		diskFreeBytes,
		attestation,
	});
	return {
		status: stored.status,
		httpRequests: metadata.attempts.length + history.attempts.length,
		certification: "NOT_CERTIFIED",
		rawClean: report.rawClean,
		directory: stored.directory,
		provenance,
	};
}
