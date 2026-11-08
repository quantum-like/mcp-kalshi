# Prerequisites for disabled Olga acceptance

What is already implemented and tested is in `INTEGRATION.md`. The items below are still outside this repository. These are prerequisites, not a live authorization and not a fresh BRTI certificate.

The independent collector 0.1.1 review is **offline code ACCEPT** and **credential-free Mac acceptance NOT SUITABLE**. This later harness does not replace that review and does not claim Mac acceptance. Linux packaged 0.1.12 remains 74 pass and is not Mac acceptance.

Still required before a disabled Olga check:

1. The pinned 0.1.12 archive stays 7430643 bytes, SHA256 `4bc4dc1773166c37bc654828030b0327304a28c77d65f5227081e4cb1676a558`. A writer who can rewrite the canonical sibling anchor can still load a substituted book.
2. Native macOS `O_EXLOCK` and a real redacted `IOPlatformUUID` must pass on the Olga Mac. This cloud run records both as not run. Linux `flock` is not that check.
3. The actual lock and identity adapters must be run on that Mac against new temp files only. No production state, credentials, or launchd.
4. Completed-hour raw BRTI must be the stored history response, 18000 rows at a 200 ms step. The history route's empty HTTP 200 body is the current hour. It is not a live feed and it does not certify a window.
5. The Nov 7 observation stays uncertified: 524455 unique trades, 2142 manifests, 12 closed windows. The first has startup gaps. Eleven have a maximum internal gap of 4 seconds. None of that tape is in this workspace.
6. Quote coverage stays uncertified: 303 snapshots are missing bid or ask across 13 windows. Eleven post-startup closed windows are quote-timing candidates only.
7. Trade completeness, late revisions, and the outcome join are not proven. Missing sides and gaps fail closed. No row is invented and no gate is relaxed.
8. `CERTIFIED.json` is not written. Provisional Coinbase and return thresholds are not certification thresholds.
9. FIT, then a frozen PREREG, then VALIDATE, then paper, remain later gates. Live orders stay off until a separate final GO. External capital stays 5.000000 total.
