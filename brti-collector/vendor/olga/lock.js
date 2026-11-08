import { spawnSync } from "node:child_process";
import { constants, realpathSync, statSync } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
/**
 * The path lock is a sibling of the canonical state directory. An alias inside
 * the state directory resolves to that same directory, so it does not grow a
 * private lock under the state tree. The state directory inode is locked as
 * well: a rename of that inode cannot be acquired through the new path while
 * the first holder is alive.
 *
 * Replacing the state directory at the original path keeps the sibling path
 * lock and fails a second acquire. The holder also fails closed when that
 * path's inode changes. An operator who can replace the sibling lock directory
 * is outside the fence. Linux uses flock. macOS is written to use O_EXLOCK and
 * is not executed here.
 */
export function hostLockDirectory(stateDirectory) {
    const root = canonicalRoot(stateDirectory);
    const lockDirectory = join(dirname(root), `.olga-a1.${basename(root)}.lockdir`);
    if (lockDirectory === root || lockDirectory.startsWith(`${root}${sep}`)) {
        throw new Error("Host lock must sit outside the state directory. No fallback host is allowed.");
    }
    return lockDirectory;
}
function canonicalRoot(stateDirectory) {
    try {
        return realpathSync(stateDirectory);
    }
    catch {
        throw new Error("State directory is unavailable. No fallback host is allowed.");
    }
}
function flockExclusive(fd, useMacLock) {
    if (useMacLock)
        return;
    const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "pipe", fd],
    });
    if (result.error || result.status !== 0) {
        throw new Error(result.error
            ? "Directory lock is unavailable. Refusing a replaceable state-path lock."
            : "Olga host lock is held. No fallback host is allowed.");
    }
}
export async function acquireHostLock(stateDirectory) {
    const root = await realpath(stateDirectory);
    const lockDirectory = hostLockDirectory(root);
    const exlock = constants.O_EXLOCK;
    const useMacLock = process.platform === "darwin" && typeof exlock === "number";
    const openFlags = constants.O_RDONLY |
        constants.O_DIRECTORY |
        (useMacLock ? exlock | constants.O_NONBLOCK : 0);
    const stateHandle = await open(root, openFlags).catch((error) => {
        if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") {
            throw new Error("Olga host lock is held. No fallback host is allowed.");
        }
        throw error;
    });
    try {
        flockExclusive(stateHandle.fd, useMacLock);
    }
    catch (error) {
        await stateHandle.close();
        throw error;
    }
    await mkdir(lockDirectory, { recursive: true });
    const dirHandle = await open(lockDirectory, openFlags).catch(async (error) => {
        await stateHandle.close();
        if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") {
            throw new Error("Olga host lock is held. No fallback host is allowed.");
        }
        throw error;
    });
    try {
        flockExclusive(dirHandle.fd, useMacLock);
    }
    catch (error) {
        await dirHandle.close();
        await stateHandle.close();
        throw error;
    }
    const dbPath = join(lockDirectory, "host.sqlite");
    let db;
    let captured;
    try {
        db = new DatabaseSync(dbPath);
        db.exec("PRAGMA busy_timeout=0");
        db.exec("BEGIN EXCLUSIVE");
        const first = await stat(dbPath);
        const second = statSync(dbPath);
        if (first.ino !== second.ino || first.dev !== second.dev) {
            throw new Error("Olga lock path was replaced. No fallback host is allowed.");
        }
        const held = await stateHandle.stat();
        const stateInfo = await stat(root);
        if (held.dev !== stateInfo.dev || held.ino !== stateInfo.ino) {
            throw new Error("State directory identity changed. No fallback host is allowed.");
        }
        captured = { dev: held.dev, ino: held.ino };
    }
    catch (error) {
        db?.close();
        await dirHandle.close();
        await stateHandle.close();
        if (error instanceof Error &&
            error.message.includes("No fallback host is allowed.")) {
            throw error;
        }
        throw new Error("Olga host lock is held. No fallback host is allowed.");
    }
    const heldDb = db;
    const bound = captured;
    let released = false;
    return {
        async assertBound() {
            const held = await stateHandle.stat();
            let now;
            try {
                now = await stat(root);
            }
            catch {
                throw new Error("State directory identity changed. No fallback host is allowed.");
            }
            if (now.dev !== bound.dev ||
                now.ino !== bound.ino ||
                held.dev !== bound.dev ||
                held.ino !== bound.ino) {
                throw new Error("State directory identity changed. No fallback host is allowed.");
            }
        },
        async release() {
            if (released)
                return;
            released = true;
            heldDb.exec("ROLLBACK");
            heldDb.close();
            await dirHandle.close();
            await stateHandle.close();
        },
    };
}
//# sourceMappingURL=lock.js.map