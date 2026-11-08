# Trust boundary for the disabled Olga candidate

This build does not claim the local book is tamper-proof. The fence is a pair of siblings that sit outside the replaceable state directory:

- `.olga-a1.<state-basename>.lockdir` — the host lock. Linux takes an inherited non-blocking `flock` on that directory plus `BEGIN EXCLUSIVE` on `host.sqlite` inside it. macOS is written to use `O_EXLOCK` on the same directory. That macOS path has not been executed.
- `.olga-a1.<state-basename>.anchor.json` — a generation, the state directory device and inode, and the SHA-256 of the six state files in order.

## What fails closed

- A second acquire of the same logical state path while the sibling lock directory is held.
- The holder’s `assertBound` after the state directory inode changes, including rename-away and copy-back onto the original path.
- `releaseUnsent` unless dispatch is `never`, state is `held`, filled count is zero, and no exit has been released. Submitting, unknown, partial, and any filled commitment stay reserved. A boolean is not proof the order was never sent.
- A fill whose outcome is missing or is not the reserved YES/NO side, or whose ticker is not the reserved market.
- Load when the anchor is missing, the file fingerprint disagrees, or the directory inode disagrees. That covers a coherent fee rewrite, a rollback to an earlier valid snapshot, and a ticker or outcome relabel that still satisfies the local arithmetic.

## What this build does not detect

A principal who can replace the sibling lock directory and rewrite the sibling anchor can also rewrite the state. Under that privilege the local anchor is not an independent witness. The offline tests include this case and expect the rewritten book to load. That is the trusted-operator case, not a passing tamper check.

Fail-closed acceptance for this fence is therefore: a writer who can edit only the state directory cannot take a second host lock, cannot free an in-flight or partial hold, and cannot roll the book back or relabel it without the external anchor. A writer who can edit the siblings too is outside the claim.

Linux `flock` is not macOS acceptance. The coordinate machine id is not evidence that `IOPlatformUUID` equals it. A ticker on a reservation is not approval to trade more than one market. Orders stay disabled.
