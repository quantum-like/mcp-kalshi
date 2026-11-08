# Read-only BRTI collector 0.1.1

This package is not the accepted a1 0.1.12 safety bundle. That archive stays
`iqai-mcp-kalshi-0.1.12-offline-bundle.tgz`, 7430643 bytes, SHA256
`4bc4dc1773166c37bc654828030b0327304a28c77d65f5227081e4cb1676a558`.
Do not rebuild it to include this collector.

The collector is a separate read-only design implementation. It has no order
signer, no Kalshi SDK import, and no trading-state lock. Independent review
is required before any Olga fetch. This cloud copy uses a mock transport
only. It does not grant a live GO.

Provisional Coinbase discrepancy numbers and the 100 bp return flag are
recorded and are not a certification threshold. A clean cadence still writes
`certification: NOT_CERTIFIED` and does not write `CERTIFIED.json`.

Provider error text, nested causes, and transport exceptions are redacted for
the exact key id, including short ids and UUIDs, plus URL and base64 forms.
A restart checks every persisted hour artifact against its hash and halts on
a mismatch. It does not repair or certify the hour. The request host stays
`https://external-api.kalshi.com`.

Linux `node:sqlite` exclusive lock is not macOS `O_EXLOCK`. This host cannot
attest Olga storage. `olga-local` is refused here. Tests use a temp directory
marked `synthetic-test`.

```bash
node --test test/*.test.js
```
