# macOS acceptance is blocked

Linux offline tests of this repository are not Olga acceptance and they are not an authenticated account check.

Blocked until a later, separate approval:

- Olga is machine `f79c77c4-4b66-4a92-9669-f49bf82f9e59` with home `/Users/olgavlasova`. The tick reads `/etc/machine-id` or macOS `IOPlatformUUID` and the password-database home. It ignores caller-supplied ids. This Linux host does not match, so the tick stops. A credential-free check that the macOS reader reports that machine is still required after an independent review passes.
- Node on Olga, including Node 24 if that is the intended runtime, is verified by an approved local command. It is unverified here.
- The disabled plist remains unloaded. Nobody runs `launchctl bootstrap` or `launchctl load` as part of acceptance.
- A separate a1 key is created in Kalshi's settings and imported into the Olga Keychain service `mcp-kalshi-a1`. This repository does not do that import.
- An approved read-only process on Olga checks member id, key id, and subaccount against the binding and checks that positions, orders, fills, settlements, and cash are complete. Unknown still fail closed.
- The host lock is a sibling directory outside the state path, with SQLite `BEGIN EXCLUSIVE` inside that directory. macOS `O_EXLOCK` on that directory is not executed here. See `docs/olga/TRUST.md`. This Linux run does not accept that path on Olga.

Until those are done, the candidate stays disabled. A passing Linux suite does not authorize a schedule, an order, or a cutover.
