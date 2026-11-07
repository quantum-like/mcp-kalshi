# Cutover review and rollback (do not execute)

Preparation of this disabled candidate is not approval to run it. Do not bootstrap the plist, do not change the a2 routine, and do not place or cancel orders.

## Review before any future approval

1. Confirm the host really is Olga. The machines named in the assessment were not labeled Olga.
2. Confirm Node on Olga, separately from the Linux acceptance of this bundle.
3. Confirm the a1 Keychain item exists and that its unattended ACL works, without printing the secret.
4. Run an approved read-only identity check and require the member id, key id, and subaccount to match the binding. A mismatch stops the candidate.
5. Re-read the open gates: live read parity, ledger ownership, matched history, source-date policy, and a qualified policy. All are still open. The tick stays `WAIT` or `STOP`.

## If a future operator had loaded the disabled plist

The checked-in plist program is `/usr/bin/false` and it has no schedule. Rollback is still:

```bash
launchctl bootout gui/$UID/com.quantumlike.mcp-kalshi.a1.olga.disabled
```

Run that only against this label, and only if a review shows the label was actually loaded. Do not boot out the a2 job. Do not delete `olga-risk.json` or the a1 ledger. Do not arm the strategy. Leave the a2 connector command where it is.

This document does not enable a scheduler and it does not change a running routine.
