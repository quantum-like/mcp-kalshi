import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateAcceptance } from "../src/accept-report.js";

const tapPass = `# tests 42
# suites 0
# pass 42
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;

const specPass = `ℹ tests 42
ℹ suites 0
ℹ pass 42
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
`;

test("TAP and Node spec summaries both count as 42 passes", () => {
	for (const output of [tapPass, specPass, `${specPass}\n${tapPass}`]) {
		const decision = evaluateAcceptance({
			output,
			status: 0,
			fileCount: 5,
			expected: 42,
		});
		assert.equal(decision.ok, true, output);
		assert.equal(decision.discovered, 42);
	}
});

test("zero tests, a wrong count, and a failure stay hard failures", () => {
	assert.match(
		evaluateAcceptance({
			output: specPass.replaceAll("42", "0").replace("# pass 0", "# pass 0"),
			status: 0,
			fileCount: 5,
			expected: 42,
		}).reason ?? "",
		/zero tests/,
	);
	const wrong = evaluateAcceptance({
		output: `ℹ tests 16
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
`,
		status: 0,
		fileCount: 5,
		expected: 42,
	});
	assert.equal(wrong.ok, false);
	assert.match(wrong.reason ?? "", /discovered 16/);
	const failed = evaluateAcceptance({
		output: tapPass
			.replace("# pass 42", "# pass 41")
			.replace("# fail 0", "# fail 1"),
		status: 1,
		fileCount: 5,
		expected: 42,
	});
	assert.equal(failed.ok, false);
	assert.match(failed.reason ?? "", /failed/);
	const files = evaluateAcceptance({
		output: "",
		status: 1,
		fileCount: 0,
		expected: 42,
	});
	assert.match(files.reason ?? "", /zero test files/);
});

test("the shipped runner rejects an empty harness", async () => {
	const directory = await mkdtemp(join(tmpdir(), "accept-empty-"));
	try {
		await mkdir(join(directory, "harness", "test"), { recursive: true });
		await writeFile(join(directory, "EXPECTED_TESTS"), "42\n");
		const result = spawnSync(process.execPath, ["offline-accept.mjs"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				PATH: process.env.PATH ?? "",
				HOME: "/tmp",
				OFFLINE_ACCEPT_ROOT: directory,
			},
		});
		assert.equal(result.status, 1);
		assert.match(`${result.stdout}\n${result.stderr}`, /zero test files/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
