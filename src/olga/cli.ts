import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDisabledTick } from "./tick.js";

/**
 * Disabled local entry. It prints WAIT or STOP and does not read credentials.
 * The launchd document does not point at this file.
 */
export async function main(argv: string[]): Promise<number> {
	const directory = argv[2];
	if (!directory) {
		process.stdout.write(
			`${JSON.stringify({
				action: "STOP",
				reasons: ["Olga state directory was not provided."],
				submits: 0,
				retries: 0,
			})}\n`,
		);
		return 2;
	}
	const decision = await runDisabledTick({
		directory: resolve(directory),
		nowMs: Date.now(),
		feedAtMs: null,
		exchangeNowMs: null,
		observedMachineId: null,
		observedHome: null,
		observed: {
			apiKeyId: null,
			memberId: null,
			subaccount: null,
			keyPresent: null,
			keychainService: null,
			readsComplete: false,
		},
	});
	process.stdout.write(`${JSON.stringify(decision)}\n`);
	return decision.action === "WAIT" ? 0 : 2;
}

function isDirectRun(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	return fileURLToPath(import.meta.url) === resolve(entry);
}

if (isDirectRun()) {
	main(process.argv)
		.then((code) => process.exit(code))
		.catch((error: unknown) => {
			const message =
				error instanceof Error ? error.message : "Olga tick failed.";
			process.stdout.write(
				`${JSON.stringify({ action: "STOP", reasons: [message], submits: 0, retries: 0 })}\n`,
			);
			process.exit(2);
		});
}
