import { DatabaseSync } from "node:sqlite";

export interface HostLock {
	release(): Promise<void>;
}

/**
 * One kernel lock on Linux and macOS. Node's built-in SQLite takes a POSIX
 * exclusive lock and the kernel drops it when this process dies. This does
 * not shell out to GNU flock and does not use the macOS-only O_EXLOCK flag.
 * A Linux run of this path is not macOS acceptance.
 */
export async function acquireHostLock(lockPath: string): Promise<HostLock> {
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(lockPath);
		db.exec("PRAGMA busy_timeout=0");
		db.exec("BEGIN EXCLUSIVE");
	} catch {
		db?.close();
		throw new Error("Olga host lock is held. No fallback host is allowed.");
	}
	const held = db;
	let released = false;
	return {
		async release() {
			if (released) return;
			released = true;
			held.exec("ROLLBACK");
			held.close();
		},
	};
}
