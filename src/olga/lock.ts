import { spawnSync } from "node:child_process";
import { constants, statSync } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface HostLock {
	assertBound(): Promise<void>;
	release(): Promise<void>;
}

/**
 * The lock directory is a sibling of the state directory, not a file inside it.
 * Replacing or renaming the state directory does not move this inode, so a
 * second process cannot acquire the same logical state. The held state
 * directory's device and inode are checked again before use.
 *
 * An operator who can also replace this sibling lock directory is outside the
 * fence. This does not claim tamper resistance against that writer.
 * Linux locks the directory with flock. macOS uses O_EXLOCK. The macOS path
 * is not executed in the Linux suite.
 */
export function hostLockDirectory(stateDirectory: string): string {
	const root = resolve(stateDirectory);
	return join(dirname(root), `.olga-a1.${basename(root)}.lockdir`);
}

export async function acquireHostLock(
	stateDirectory: string,
): Promise<HostLock> {
	const root = resolve(stateDirectory);
	const lockDirectory = hostLockDirectory(root);
	if (lockDirectory === root || lockDirectory.startsWith(`${root}${sep}`)) {
		throw new Error(
			"Host lock must sit outside the state directory. No fallback host is allowed.",
		);
	}
	await mkdir(lockDirectory, { recursive: true });
	const exlock = (constants as { O_EXLOCK?: number }).O_EXLOCK;
	const useMacLock =
		process.platform === "darwin" && typeof exlock === "number";
	const dirHandle = await open(
		lockDirectory,
		constants.O_RDONLY |
			constants.O_DIRECTORY |
			(useMacLock ? exlock | constants.O_NONBLOCK : 0),
	).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") {
			throw new Error("Olga host lock is held. No fallback host is allowed.");
		}
		throw error;
	});
	if (!useMacLock) {
		const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
			stdio: ["ignore", "ignore", "pipe", dirHandle.fd],
		});
		if (result.error || result.status !== 0) {
			await dirHandle.close();
			throw new Error(
				result.error
					? "Directory lock is unavailable. Refusing a replaceable state-path lock."
					: "Olga host lock is held. No fallback host is allowed.",
			);
		}
	}
	const dbPath = join(lockDirectory, "host.sqlite");
	let db: DatabaseSync | undefined;
	let captured: { dev: number; ino: number };
	try {
		db = new DatabaseSync(dbPath);
		db.exec("PRAGMA busy_timeout=0");
		db.exec("BEGIN EXCLUSIVE");
		const first = await stat(dbPath);
		const second = statSync(dbPath);
		if (first.ino !== second.ino || first.dev !== second.dev) {
			throw new Error(
				"Olga lock path was replaced. No fallback host is allowed.",
			);
		}
		const stateInfo = await stat(root);
		captured = { dev: stateInfo.dev, ino: stateInfo.ino };
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
	const bound = captured;
	let released = false;
	return {
		async assertBound() {
			const now = await stat(root);
			if (now.dev !== bound.dev || now.ino !== bound.ino) {
				throw new Error(
					"State directory identity changed. No fallback host is allowed.",
				);
			}
		},
		async release() {
			if (released) return;
			released = true;
			heldDb.exec("ROLLBACK");
			heldDb.close();
			await dirHandle.close();
		},
	};
}
