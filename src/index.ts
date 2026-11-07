#!/usr/bin/env node
import { FastMCP } from "fastmcp";
import { a1Tools } from "./tools/a1.js";
import { marketTools } from "./tools/markets.js";
import { orderTools } from "./tools/orders.js";
import { portfolioTools } from "./tools/portfolio.js";

async function main() {
	const server = new FastMCP({
		name: "Kalshi MCP Server",
		version: "0.0.1",
	});

	// Register all tools
	for (const tool of marketTools) {
		// biome-ignore lint: fastmcp types are overly strict
		server.addTool(tool as any);
	}
	for (const tool of portfolioTools) {
		// biome-ignore lint: fastmcp types are overly strict
		server.addTool(tool as any);
	}
	for (const tool of orderTools) {
		// biome-ignore lint: fastmcp types are overly strict
		server.addTool(tool as any);
	}
	for (const tool of a1Tools) {
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
