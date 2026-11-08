# Trust boundary for the disabled Olga candidate

This build does not claim the local book is tamper-proof. It is an integrity fence for a state-file writer. It is not exchange attestation and it is not a protected history against someone who can rewrite the witnesses below.

The fence has three parts, all derived from the canonical directory (`realpath`), not from an alias path:

- A lock on the state directory inode, so a second acquire of that same inode through a symlink or a renamed path fails while the first holder is alive.
- `.olga-a1.<canonical-basename>.lockdir`, a sibling of that directory. Linux takes an inherited non-blocking `flock` on it plus `BEGIN EXCLUSIVE` on `host.sqlite` inside it. Replacing the directory at the original path does not move this lock, so a second acquire of that path still fails. macOS is written to use `O_EXLOCK` on these directories. That path has not been executed.
- `.olga-a1.<canonical-basename>.anchor.json`, also a sibling. It stores version 1, a safe integer generation, the directory device and inode, and the SHA-256 of the six state files.

## What fails closed

- A second acquire of the same canonical path, including after the directory inode at that path is replaced.
- A second acquire of the same directory inode through an in-tree symlink or a new pathname.
- The holder's `assertBound` when the canonical path no longer names the inode that was locked, checked again before a tick persists a clock.
- `releaseUnsent` unless dispatch is `never`, state is `held`, filled count is zero, and no exit has been released. Submitting, unknown, partial, and any filled commitment stay reserved. A boolean is not proof the order was never sent.
- A fill whose outcome is missing or is not the reserved YES/NO side, or whose ticker is not the reserved market.
- Load when the anchor is missing, malformed, the wrong version, a non-integer generation, the fingerprint disagrees, or the directory inode disagrees.
- A save of the clock, the risk file, or the binding unless the current files and inode already match the anchor. The save then publishes generation + 1 for that snapshot plus the one file it wrote. A state-only rollback, including one that lands during the tick after the loads and before the clock write, is not reanchored. A missing anchor is not recreated. A swapped-in directory is not adopted.

## What this build does not detect

A principal who can replace the sibling lock directory and rewrite the sibling anchor of the canonical path can also rewrite the state. Under that privilege the local anchor is not an independent witness. The offline tests include this case and expect the rewritten book to load. That is the trusted-operator case, not a passing tamper check.

Placing the anchor one directory above the state files is not, by itself, the boundary. The boundary is that ordinary saves refuse to certify bytes they did not already validate. A writer limited to the state directory still cannot take a second lock, free an in-flight or partial hold, or have a clock save bless a rollback or a replacement directory.

Linux `flock` is not macOS acceptance. The coordinate machine id is not evidence that `IOPlatformUUID` equals it. A ticker on a reservation is not approval to trade more than one market. Orders stay disabled.
