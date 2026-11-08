export type McpProfile = "a1" | "a2";

export class MutationBlockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MutationBlockedError";
	}
}

/** Default is the disarmed a1 profile. a2 is an explicit compatibility opt-in. */
export function resolveProfile(
	env: NodeJS.ProcessEnv = process.env,
): McpProfile {
	const raw = (env.KALSHI_MCP_PROFILE ?? "a1").trim().toLowerCase();
	if (raw === "a1" || raw === "") return "a1";
	if (raw === "a2") return "a2";
	throw new Error(
		`Unknown KALSHI_MCP_PROFILE "${raw}". Refusing to start rather than enabling writes.`,
	);
}

export function assertA2Mutation(profile: McpProfile): void {
	if (profile !== "a2") {
		throw new MutationBlockedError(
			"A1 profile is read-only. This mutation is blocked before any SDK client or transport is constructed.",
		);
	}
}

export const A1_MUTATION_TOOL_NAMES = [
	"CREATE_ORDER",
	"CANCEL_ORDER",
	"DECREASE_ORDER",
	"BATCH_CANCEL_ORDERS",
] as const;
