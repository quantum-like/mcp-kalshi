import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

test("collector sources do not import orders, signers, shells, or the safety bundle", async () => {
	const directory = new URL("../src/", import.meta.url);
	const names = (await readdir(directory)).filter((name) => name.endsWith(".js"));
	assert.equal(names.length > 0, true);
	const banned = [
		"kalshi-typescript",
		"child_process",
		"src/olga",
		"src/services",
		"createOrder",
		"CERTIFIED.json",
		"launchctl",
		"KALSHI_PRIVATE_KEY",
	];
	for (const name of names) {
		const source = await readFile(new URL(name, directory), "utf8");
		for (const token of banned) assert.equal(source.includes(token), false, `${name} contains ${token}`);
		assert.equal(/(?<!\.)\bexec\s*\(/.test(source), false, name);
		assert.equal(/(?<!\.)\bspawn\s*\(/.test(source), false, name);
	}
});
