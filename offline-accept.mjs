import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateAcceptance } from "./dist/accept-report.js";

const root = process.env.OFFLINE_ACCEPT_ROOT
	? process.env.OFFLINE_ACCEPT_ROOT
	: dirname(fileURLToPath(import.meta.url));
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
const expected = Number(
	readFileSync(join(root, "EXPECTED_TESTS"), "utf8").trim(),
);
if (files.length === 0) {
	const decision = evaluateAcceptance({
		output: "",
		status: 1,
		fileCount: 0,
		expected,
	});
	console.error(`FAIL: ${decision.reason}`);
	process.exit(1);
}
const result = spawnSync(
	process.execPath,
	[
		"--test",
		"--test-reporter=tap",
		"--test-reporter-destination=stdout",
		...files,
	],
	{
		cwd: root,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: "/tmp",
			LANG: "C",
		},
	},
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
const decision = evaluateAcceptance({
	output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
	status: result.status,
	fileCount: files.length,
	expected,
});
if (!decision.ok) {
	console.error(`FAIL: ${decision.reason}`);
	process.exit(1);
}
console.error(`PASS: ${decision.discovered} offline tests`);
