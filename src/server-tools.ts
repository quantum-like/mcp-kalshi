import type { McpProfile } from "./profile.js";
import { a1Tools } from "./tools/a1.js";
import { marketTools } from "./tools/markets.js";
import { orderTools } from "./tools/orders.js";
import { portfolioTools } from "./tools/portfolio.js";

export function toolsForProfile(profile: McpProfile) {
	const reads = [...marketTools, ...portfolioTools, ...a1Tools];
	if (profile === "a2") {
		return [...reads, ...orderTools];
	}
	return reads;
}
