import { acquireHostLock } from "../../src/olga/lock.ts";

const lockPath = process.argv[2];
if (!lockPath) throw new Error("lock path required");
const lock = await acquireHostLock(lockPath);
process.stdout.write("held\n");
setInterval(() => {
	void lock;
}, 1_000);
