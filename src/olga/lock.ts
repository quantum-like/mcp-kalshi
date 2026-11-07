import { spawnSync } from "node:child_process";
import { constants, closeSync, openSync } from "node:fs";
import { open } from "node:fs/promises";

export interface HostLock {
	release(): Promise<void>;
}

/**
 * Exclusive kernel lock. On macOS, Node exposes O_EXLOCK and the kernel drops
 * it when the process dies. On Linux, the same open-file description is locked
 * with the flock command and stays held until this process closes the fd.
 * There is no PID-file fallback.
 */
export async function acquireHostLock(lockPath: string): Promise<HostLock> {
	const exlock = (constants as { O_EXLOCK?: number }).O_EXLOCK;
	if (typeof exlock === "number") {
		try {
			const handle = await open(
				lockPath,
				constants.O_CREAT | constants.O_RDWR | exlock | constants.O_NONBLOCK,
				0o600,
			);
			return {
				async release() {
					await handle.close();
				},
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EAGAIN" || code === "EWOULDBLOCK") {
				throw new Error("Olga host lock is held. No fallback host is allowed.");
			}
			throw error;
		}
	}
	return acquireWithFlock(lockPath);
}

function acquireWithFlock(lockPath: string): HostLock {
	const fd = openSync(lockPath, "a+", 0o600);
	const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
		stdio: ["ignore", "ignore", "pipe", fd],
	});
	if (result.error || result.status !== 0) {
		closeSync(fd);
		if (result.error) {
			throw new Error(
				"Kernel file lock is unavailable. Refusing a PID-lock fallback.",
			);
		}
		throw new Error("Olga host lock is held. No fallback host is allowed.");
	}
	let released = false;
	return {
		async release() {
			if (released) return;
			released = true;
			closeSync(fd);
		},
	};
}
