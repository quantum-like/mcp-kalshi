import { spawnSync } from "node:child_process";
import { constants, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface HostLock {
	release(): Promise<void>;
}

/**
 * The mutual exclusion is the state directory inode, plus the SQLite file.
 * Replacing the lock file's pathname does not create a second owner, because
 * the directory itself stays exclusively locked until this process releases
 * it or dies. A Linux run is not macOS acceptance.
 */
export async function acquireHostLock(lockPath: string): Promise<HostLock> {
	const directory = dirname(lockPath);
	const exlock = (constants as { O_EXLOCK?: number }).O_EXLOCK;
	const dirHandle =
		process.platform === "darwin" && typeof exlock === "number"
			? await open(
					directory,
					constants.O_RDONLY |
						constants.O_DIRECTORY |
						exlock |
						constants.O_NONBLOCK,
				).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") {
						throw new Error(
							"Olga host lock is held. No fallback host is allowed.",
						);
					}
					throw error;
				})
			: await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
	if (!(process.platform === "darwin" && typeof exlock === "number")) {
		const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
			stdio: ["ignore", "ignore", "pipe", dirHandle.fd],
		});
		if (result.error || result.status !== 0) {
			await dirHandle.close();
			throw new Error(
				result.error
					? "Directory lock is unavailable. Refusing a replaceable file lock."
					: "Olga host lock is held. No fallback host is allowed.",
			);
		}
	}
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(lockPath);
		db.exec("PRAGMA busy_timeout=0");
		db.exec("BEGIN EXCLUSIVE");
		const held = await stat(lockPath);
		const again = statSync(lockPath);
		if (held.ino !== again.ino || held.dev !== again.dev) {
			throw new Error(
				"Olga lock path was replaced. No fallback host is allowed.",
			);
		}
	} catch (error) {
		db?.close();
		await dirHandle.close();
		if (
			error instanceof Error &&
			error.message.includes("No fallback host is allowed.")
		) {
			throw error;
		}
		throw new Error("Olga host lock is held. No fallback host is allowed.");
	}
	const heldDb = db;
	let released = false;
	return {
		async release() {
			if (released) return;
			released = true;
			heldDb.exec("ROLLBACK");
			heldDb.close();
			await dirHandle.close();
		},
	};
}
