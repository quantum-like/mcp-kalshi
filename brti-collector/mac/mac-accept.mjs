import { constants, existsSync, readFileSync } from "node:fs";
import { cp, mkdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const collectorRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const report = {
	harness: "credential-free-mac-acceptance",
	suitable_for_mac_acceptance: false,
	orders_enabled: false,
	network: false,
	credentials: false,
	external_capital: null,
	o_exlock: { status: "NOT_RUN", value_emitted: false },
	io_platform_uuid: { status: "NOT_RUN", value_emitted: false },
	linux_adapter: { status: "NOT_RUN" },
	linux_packaged_0_1_12: "74 pass is not mac acceptance",
	collector_0_1_1_review: "OFFLINE CODE ACCEPT is not credential-free Mac acceptance",
};

function emit(exitCode) {
	process.stdout.write(`${JSON.stringify(report)}\n`);
	process.exit(exitCode);
}

const adapterDir = [path.join(repoRoot, "dist/olga"), path.join(collectorRoot, "vendor/olga")].find((dir) =>
	existsSync(path.join(dir, "lock.js")),
);
if (!adapterDir) {
	report.linux_adapter = { status: "BLOCK", reason: "compiled adapter is unavailable" };
	emit(2);
}
const lockModule = await import(pathToFileURL(path.join(adapterDir, "lock.js")).href);
const hostModule = await import(pathToFileURL(path.join(adapterDir, "host-identity.js")).href);
try {
	const tickModule = await import(pathToFileURL(path.join(repoRoot, "dist/olga/tick.js")).href);
	const stateModule = await import(pathToFileURL(path.join(repoRoot, "dist/olga/state.js")).href);
	report.orders_enabled = tickModule.OLGA_DISABLED !== true;
	report.external_capital = stateModule.MAX_EXTERNAL_CAPITAL;
} catch {
	const invariants = JSON.parse(readFileSync(path.join(collectorRoot, "vendor/invariants.json"), "utf8"));
	report.orders_enabled = invariants.orders_disabled !== true;
	report.external_capital = invariants.external_capital;
}
if (report.orders_enabled || report.external_capital !== "5.000000") emit(2);

const nativeExlock = process.platform === "darwin" && typeof constants.O_EXLOCK === "number";
if (!nativeExlock) {
	report.o_exlock = {
		status: "BLOCK",
		reason: "native macOS O_EXLOCK is not available in this process",
		value_emitted: false,
	};
	report.io_platform_uuid = {
		status: "NOT_RUN",
		reason: "IOPlatformUUID is only read on macOS",
		value_emitted: false,
	};
} else {
	report.o_exlock = { status: "UNVERIFIED", reason: "flag exists; this harness does not claim adapter acceptance", value_emitted: false };
	try {
		const host = hostModule.readHostIdentity();
		const present = typeof host?.machineId === "string" && host.machineId.length > 0 && host.machineId !== "unsupported-platform";
		report.io_platform_uuid = { status: present ? "PRESENT_REDACTED" : "BLOCK", value_emitted: false };
	} catch {
		report.io_platform_uuid = { status: "BLOCK", value_emitted: false };
	}
}

if (process.platform === "linux") {
	try {
		const host = hostModule.readHostIdentity();
		if (typeof host?.machineId !== "string" || host.machineId.length === 0) throw new Error("empty");
		report.linux_identity_read_without_printing = true;
	} catch {
		report.linux_identity_read_without_printing = false;
	}
	const root = await mkdirTemp();
	const directory = path.join(root, "state");
	await mkdir(directory);
	const first = await lockModule.acquireHostLock(directory);
	const alias = path.join(directory, "alias");
	await symlink(".", alias);
	let aliasBlocked = false;
	try {
		await lockModule.acquireHostLock(alias);
	} catch {
		aliasBlocked = true;
	}
	await first.release();
	const held = await lockModule.acquireHostLock(directory);
	const moved = path.join(root, "moved");
	await rename(directory, moved);
	await cp(moved, directory, { recursive: true });
	let replacementBlocked = false;
	let boundRejected = false;
	try {
		await lockModule.acquireHostLock(directory);
	} catch {
		replacementBlocked = true;
	}
	try {
		await held.assertBound();
	} catch {
		boundRejected = true;
	}
	await held.release();
	await rm(root, { recursive: true, force: true });
	await rm(path.join(path.dirname(directory), `.olga-a1.state.lockdir`), { recursive: true, force: true }).catch(() => undefined);
	report.linux_adapter = {
		status: aliasBlocked && replacementBlocked && boundRejected ? "PASS_LINUX_ONLY" : "FAIL",
		alias_blocked: aliasBlocked,
		replacement_blocked: replacementBlocked,
		bound_rejected: boundRejected,
		not_mac_acceptance: true,
	};
	if (report.linux_adapter.status !== "PASS_LINUX_ONLY") emit(2);
}

report.suitable_for_mac_acceptance = false;
emit(0);

async function mkdirTemp() {
	const { mkdtemp } = await import("node:fs/promises");
	return mkdtemp(path.join(tmpdir(), "a1-mac-harness-"));
}
