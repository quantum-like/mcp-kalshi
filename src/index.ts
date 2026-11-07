#!/usr/bin/env node
import { FastMCP } from "fastmcp";
import { resolveProfile } from "./profile.js";
import { toolsForProfile } from "./server-tools.js";

async function main() {
	const profile = resolveProfile();
	const server = new FastMCP({
		name: "Kalshi MCP Server",
		version: profile === "a2" ? "0.1.2" : "0.1.6",
	});

	for (const tool of toolsForProfile(profile)) {
		// biome-ignore lint: fastmcp types are overly strict
		server.addTool(tool as any);
	}

	try {
		await server.start({
			transportType: "stdio",
		});
	} catch (error) {
		console.error("Failed to start Kalshi MCP Server:", error);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(
		"An unexpected error occurred in the Kalshi MCP Server:",
		error,
	);
	process.exit(1);
});
