# macOS acceptance is blocked

Linux offline tests of this repository are not Olga acceptance and they are not an authenticated account check.

Blocked until a later, separate approval:

- Olga's machine id is confirmed. The assessment's connected desktops were not named Olga.
- Node on Olga, including Node 24 if that is the intended runtime, is verified by an approved local command. It is unverified here.
- The disabled plist remains unloaded. Nobody runs `launchctl bootstrap` or `launchctl load` as part of acceptance.
- A separate a1 key is created in Kalshi's settings and imported into the Olga Keychain service `mcp-kalshi-a1`. This repository does not do that import.
- An approved read-only process on Olga checks member id, key id, and subaccount against the binding and checks that positions, orders, fills, settlements, and cash are complete. Unknown still fail closed.
- The kernel lock path on macOS is `O_EXLOCK`. This Linux build exercises `flock` on an inherited descriptor instead. `O_EXLOCK` was not executed here.

Until those are done, the candidate stays disabled. A passing Linux suite does not authorize a schedule, an order, or a cutover.
