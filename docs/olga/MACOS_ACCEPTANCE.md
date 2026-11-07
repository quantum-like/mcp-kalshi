# macOS acceptance is blocked

Linux offline tests of this repository are not Olga acceptance and they are not an authenticated account check.

Blocked until a later, separate approval:

- Olga's machine id is confirmed. The assessment's connected desktops were not named Olga.
- Node on Olga, including Node 24 if that is the intended runtime, is verified by an approved local command. It is unverified here.
- The disabled plist remains unloaded. Nobody runs `launchctl bootstrap` or `launchctl load` as part of acceptance.
- A separate a1 key is created in Kalshi's settings and imported into the Olga Keychain service `mcp-kalshi-a1`. This repository does not do that import.
- An approved read-only process on Olga checks member id, key id, and subaccount against the binding and checks that positions, orders, fills, settlements, and cash are complete. Unknown still fail closed.
- The host lock is Node's built-in SQLite exclusive lock, the same code path on Linux and macOS. This Linux run does not accept that path on Olga. A credential-free check on the confirmed machine `f79c77c4-4b66-4a92-9669-f49bf82f9e59` is still required. The owner file stores that machine id and `/Users/olgavlasova`. A text label is rejected. This repository does not query the Mac.

Until those are done, the candidate stays disabled. A passing Linux suite does not authorize a schedule, an order, or a cutover.
