import { DatabaseSync } from "node:sqlite";
import { chmod, lstat, link, mkdir, open, statfs } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { CollectorHalt, halt } from "./errors.js";
import { sha256 } from "./certify.js";

export const DISK_FLOOR_BYTES = 5 * 1024 * 1024 * 1024;

function hourParts(iso) {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):00:00\.000Z$/.exec(iso);
	if (!match) halt("hour_alignment", "Hour path is not an aligned UTC label.");
	return { year: match[1], month: match[2], day: match[3], hour: match[4] };
}

export function hourDirectory(root, iso) {
	const parts = hourParts(iso);
	return path.join(root, "BRTI", parts.year, parts.month, parts.day, parts.hour);
}

async function assertNoSymlink(root) {
	if (!path.isAbsolute(root)) halt("storage_root", "Storage root must be absolute.");
	const segments = root.split(path.sep).filter(Boolean);
	let current = path.sep;
	for (const segment of segments) {
		current = path.join(current, segment);
		const info = await lstat(current);
		if (info.isSymbolicLink()) halt("symlink_root", "Storage path contains a symlink.");
	}
}

export async function assertStorageRoot(root, attestation, diskFreeBytes) {
	await assertNoSymlink(root);
	const info = await lstat(root);
	if (!info.isDirectory()) halt("storage_root", "Storage root is not a directory.");
	if (info.uid !== process.getuid()) halt("storage_root", "Storage root is not owned by this user.");
	if ((info.mode & 0o777) !== 0o700) halt("storage_root", "Storage root mode is not 0700.");
	const kind = attestation?.kind;
	if (kind === "box" || kind === undefined) {
		halt("storage_host", "Refusing an unspecified or box storage host.");
	}
	if (kind === "synthetic-test") {
		const temp = realpathSync(tmpdir());
		if (!realpathSync(root).startsWith(`${temp}${path.sep}`)) {
			halt("storage_host", "Synthetic storage is only allowed under the temp directory.");
		}
	} else if (kind === "olga-local") {
		if (process.platform !== "darwin" || attestation.affirmed !== true || "machineId" in attestation) {
			halt("storage_host", "Olga storage is not attested on this host, and hardware ids are not recorded.");
		}
	} else {
		halt("storage_host", "Storage host attestation is not recognized.");
	}
	const free = diskFreeBytes ?? (await statfs(root)).bavail * (await statfs(root)).bsize;
	if (free < DISK_FLOOR_BYTES) halt("disk", "Free space is below 5 GiB. Refusing to delete or rotate.");
}

export function acquireCollectorLock(root) {
	const db = new DatabaseSync(path.join(root, ".brti-collector.lock.sqlite"));
	db.exec("PRAGMA busy_timeout=0");
	try {
		db.exec("BEGIN EXCLUSIVE");
	} catch (error) {
		db.close();
		const message = error instanceof Error ? error.message : "";
		if (message.includes("locked") || message.includes("SQLITE_BUSY")) {
			halt("lock_held", "Collector lock is held. No trading-state fallback.");
		}
		halt("lock_held", "Collector lock failed closed.");
	}
	return {
		release() {
			db.exec("ROLLBACK");
			db.close();
		},
	};
}

async function writeExclusive(file, bytes) {
	const handle = await open(file, "wx", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await chmod(file, 0o600);
}

async function fsyncDirectory(directory) {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function readFileBytes(file) {
	const handle = await open(file, "r");
	try {
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

export async function inspectHour(root, iso) {
	const directory = hourDirectory(root, iso);
	let info;
	try {
		info = await lstat(directory);
	} catch (error) {
		if (error?.code === "ENOENT") return { status: "absent", directory };
		throw error;
	}
	if (info.isSymbolicLink()) halt("symlink_root", "Hour path is a symlink.");
	let marker;
	try {
		marker = await readFileBytes(path.join(directory, "COMPLETE.json"));
	} catch (error) {
		if (error?.code === "ENOENT") halt("partial_hour", "Hour directory is incomplete. Leaving it for review.");
		throw error;
	}
	const response = await readFileBytes(path.join(directory, "response.json"));
	const recorded = (await readFileBytes(path.join(directory, "response.sha256"))).toString("utf8").trim();
	if (sha256(response) !== recorded) {
		halt("integrity_incident", "Stored hour hash does not match its bytes.");
	}
	let complete;
	try {
		complete = JSON.parse(marker.toString("utf8"));
	} catch {
		halt("integrity_incident", "Completion marker is unreadable.");
	}
	if (complete.response_sha256 !== recorded) {
		halt("integrity_incident", "Completion marker does not match the stored hash.");
	}
	if (complete.certification !== "NOT_CERTIFIED" && complete.certification !== "REJECTED") {
		halt("integrity_incident", "Completion marker is not a fail-closed certification result.");
	}
	let provenance;
	try {
		provenance = JSON.parse((await readFileBytes(path.join(directory, "provenance.json"))).toString("utf8"));
	} catch {
		halt("integrity_incident", "Provenance is unreadable.");
	}
	if (provenance.certification !== complete.certification || provenance.certification === "CERTIFIED") {
		halt("integrity_incident", "Provenance certification does not match the fail-closed marker.");
	}
	if (complete.files && typeof complete.files === "object") {
		for (const [name, hash] of Object.entries(complete.files)) {
			if (typeof hash !== "string") halt("integrity_incident", "Stored file hash is unreadable.");
			const bytes = await readFileBytes(path.join(directory, name));
			if (sha256(bytes) !== hash) {
				halt("integrity_incident", "A persisted hour artifact does not match its recorded hash.");
			}
		}
	}
	await verifySidecar(directory, "deduped.json", "deduped.sha256");
	await verifySidecar(directory, "REJECTED.json", "REJECTED.sha256");
	return { status: "match", directory, sha256: recorded };
}

async function verifySidecar(directory, name, hashName) {
	const file = path.join(directory, name);
	const hashFile = path.join(directory, hashName);
	const hasFile = await fileExists(file);
	const hasHash = await fileExists(hashFile);
	if (!hasFile && !hasHash) return;
	if (!hasFile || !hasHash) {
		halt("integrity_incident", "A persisted sidecar is missing its hash.");
	}
	const bytes = await readFileBytes(file);
	const recorded = (await readFileBytes(hashFile)).toString("utf8").trim();
	if (sha256(bytes) !== recorded) {
		halt("integrity_incident", "A persisted sidecar does not match its hash.");
	}
}

async function fileExists(file) {
	try {
		await lstat(file);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

export async function commitHour({
	root,
	iso,
	responseBytes,
	provenance,
	dedupedBytes,
	rejectedBytes,
	crashBefore,
	diskFreeBytes,
	attestation,
}) {
	await assertStorageRoot(root, attestation, diskFreeBytes);
	const lock = acquireCollectorLock(root);
	try {
		const existing = await inspectHour(root, iso);
		if (existing.status === "match") {
			if (existing.sha256 !== sha256(responseBytes)) {
				halt("integrity_incident", "Existing hour does not match this response.");
			}
			return { status: "exists", directory: existing.directory };
		}
		const staging = path.join(root, ".staging", cryptoRandom());
		await mkdir(staging, { recursive: true, mode: 0o700 });
		await chmod(staging, 0o700);
		const responseHash = sha256(responseBytes);
		const responseShaBytes = Buffer.from(`${responseHash}\n`);
		const provenanceBytes = Buffer.from(`${JSON.stringify(provenance)}\n`);
		const files = {
			"response.json": responseHash,
			"response.sha256": sha256(responseShaBytes),
			"provenance.json": sha256(provenanceBytes),
		};
		await writeExclusive(path.join(staging, "response.json"), responseBytes);
		await writeExclusive(path.join(staging, "response.sha256"), responseShaBytes);
		await writeExclusive(path.join(staging, "provenance.json"), provenanceBytes);
		let dedupedShaBytes = null;
		if (dedupedBytes) {
			dedupedShaBytes = Buffer.from(`${sha256(dedupedBytes)}\n`);
			files["deduped.json"] = sha256(dedupedBytes);
			files["deduped.sha256"] = sha256(dedupedShaBytes);
			await writeExclusive(path.join(staging, "deduped.json"), dedupedBytes);
			await writeExclusive(path.join(staging, "deduped.sha256"), dedupedShaBytes);
		}
		await fsyncDirectory(staging);
		await boundary(crashBefore, "after-staging");
		const finalDirectory = hourDirectory(root, iso);
		await mkdir(path.dirname(finalDirectory), { recursive: true, mode: 0o700 });
		await mkdir(finalDirectory, { mode: 0o700 });
		await chmod(finalDirectory, 0o700);
		await boundary(crashBefore, "after-final-dir");
		for (const name of ["response.json", "response.sha256", "provenance.json", "deduped.json", "deduped.sha256"]) {
			const from = path.join(staging, name);
			try {
				await lstat(from);
			} catch {
				continue;
			}
			await link(from, path.join(finalDirectory, name));
		}
		await boundary(crashBefore, "after-link");
		if (rejectedBytes) {
			const rejectedShaBytes = Buffer.from(`${sha256(rejectedBytes)}\n`);
			files["REJECTED.json"] = sha256(rejectedBytes);
			files["REJECTED.sha256"] = sha256(rejectedShaBytes);
			await writeExclusive(path.join(finalDirectory, "REJECTED.json"), rejectedBytes);
			await writeExclusive(path.join(finalDirectory, "REJECTED.sha256"), rejectedShaBytes);
		}
		const marker = {
			ingestion: "durable",
			certification: provenance.certification,
			response_sha256: responseHash,
			files,
		};
		await writeExclusive(path.join(finalDirectory, "COMPLETE.json"), Buffer.from(`${JSON.stringify(marker)}\n`));
		await fsyncDirectory(finalDirectory);
		await fsyncDirectory(root);
		return { status: "stored", directory: finalDirectory, staging };
	} finally {
		lock.release();
	}
}

function boundary(crashBefore, name) {
	if (crashBefore === name) throw new CollectorHalt("crash_injected", name);
}

function cryptoRandom() {
	return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
