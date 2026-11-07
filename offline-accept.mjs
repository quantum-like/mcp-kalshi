import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const testDir = join(root, "harness", "test");
let files = [];
try {
	files = readdirSync(testDir)
		.filter((name) => name.endsWith(".test.js"))
		.sort()
		.map((name) => join(testDir, name));
} catch {
	console.error("FAIL: harness/test is missing. Zero tests discovered.");
	process.exit(1);
}
if (files.length === 0) {
	console.error("FAIL: zero test files discovered.");
	process.exit(1);
}
const expected = Number(
	readFileSync(join(root, "EXPECTED_TESTS"), "utf8").trim(),
);
if (!Number.isInteger(expected) || expected < 1) {
	console.error("FAIL: EXPECTED_TESTS is missing or zero.");
	process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files], {
	cwd: root,
	encoding: "utf8",
	env: {
		PATH: process.env.PATH ?? "",
		HOME: "/tmp",
		LANG: "C",
	},
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
const match = (result.stdout ?? "").match(/^# tests (\d+)/m);
const discovered = match ? Number(match[1]) : 0;
if (discovered === 0) {
	console.error("FAIL: zero tests discovered.");
	process.exit(1);
}
if (discovered !== expected) {
	console.error(`FAIL: expected ${expected} tests, discovered ${discovered}.`);
	process.exit(1);
}
if ((result.status ?? 1) !== 0) {
	process.exit(result.status ?? 1);
}
console.error(`PASS: ${discovered} offline tests`);
