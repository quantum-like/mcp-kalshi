# Git correspondence for the accepted 0.1.12 archive

This note is an author check against GitHub. It is not the independent reviewer's
mapping, and it does not replace that review. The independent Linux review of
0.1.12 accepted the offline fence for one archive and said GitHub correspondence
was unverified because that review did not contact GitHub.

## What GitHub returned

Read with `gh api` and `gh pr view` before this collector commit:

- Commit `7e3edacdf1ce8611650ad978f1ef94462eced673`
- Parent `ca76b531e283348cc3c98bdde768a39fd9117934`
- Tree `3ac1b6ebf26645ae7dc6fee6ac9049a813c01d46`
- Parent of that parent: `917dff61dbac00aceee9bb1cde11d71b96f739e0`
- Pull request https://github.com/quantum-like/mcp-kalshi/pull/2
- At that read, PR 2 `headRefOid` was `7e3edacdf1ce8611650ad978f1ef94462eced673` on `cursor/a1-readiness-5a91`
- Local `git rev-parse 7e3edac^{tree}` is the same tree id

The collector commit is a later descendant. It does not rewrite `7e3edac`.
The accepted archive was built from `7e3edac`, not from the collector commit.

## What the archive comparison shows

Archive `/opt/cursor/artifacts/iqai-mcp-kalshi-0.1.12-offline-bundle.tgz`

- 7430643 bytes
- SHA256 `4bc4dc1773166c37bc654828030b0327304a28c77d65f5227081e4cb1676a558`
- `PROVENANCE.json` inside it names commit `7e3edac` and parent `ca76b531`

Compared with `git ls-tree -r 7e3edac` (git blob SHA1 of the file bytes):

- 57 committed paths in the archive match the git blobs. They are the
  implementation, tests, docs, lockfile, plist, runner, and `EXPECTED_TESTS`
  listed below. They are not the generated harness.
- `package.json` is the one differing committed file. The only field that
  differs is `description`. Git says the marketplace description. The archive
  says the offline-bundle description. Name, version `0.1.12`, and dependency
  entries match.
- Archive-only paths: `dist` 108 files, `harness` 8 files, `node_modules` 5413
  files, plus generated `PROVENANCE.json` and `RUN.txt`.
- Git paths absent from the archive: `.changeset/config.json`, three
  `.github` workflow files, `generate-tools.mjs`, `.gitignore`, `CHANGELOG.md`,
  `biome.json`, `tsconfig.json`.

GitHub does not host this tarball. Matching blobs shows the committed sources
inside the archive are the `7e3edac` tree. It does not show that GitHub built
`dist/` or `harness/`. Those generated files stay inside the pinned archive.
This check did not rebuild them.

## Matched paths

```
EXPECTED_TESTS
README.md
deploy/olga/com.quantumlike.mcp-kalshi.a1.olga.disabled.plist
docs/olga/ADAPTATION.md
docs/olga/CUTOVER.md
docs/olga/KEYCHAIN.md
docs/olga/MACOS_ACCEPTANCE.md
docs/olga/SOURCE.md
docs/olga/TRUST.md
offline-accept.mjs
pnpm-lock.yaml
src/accept-report.ts
src/constants.ts
src/data-guard/sealed-window.ts
src/index.ts
src/lib/config.ts
src/lib/fixed.ts
src/lib/http.ts
src/lib/pst.ts
src/olga/cli.ts
src/olga/decide.ts
src/olga/host-identity.ts
src/olga/lock.ts
src/olga/positions.ts
src/olga/state.ts
src/olga/tick.ts
src/orders/price-grid.ts
src/profile.ts
src/reads/account-read-service.ts
src/reads/format.ts
src/reads/paginate.ts
src/server-tools.ts
src/services/create-order-v2-adapter.ts
src/services/kalshi-client.ts
src/services/markets-service.ts
src/services/orders-service.ts
src/services/portfolio-service.ts
src/strategy/boundary.ts
src/strategy/fees.ts
src/strategy/ledger.ts
src/strategy/reconcile.ts
src/strategy/submit.ts
src/tools/a1.ts
src/tools/markets.ts
src/tools/orders.ts
src/tools/portfolio.ts
src/types.ts
test/a1-ledger-and-dates.test.ts
test/a1-profile-gate.test.ts
test/a1-reads-and-grid.test.ts
test/helpers/olga-hold.ts
test/offline-accept-runner.test.ts
test/offline-transport.ts
test/olga-attacks.test.ts
test/olga-disabled.test.ts
test/orders-v2.test.ts
test/read-sdk-drift.test.ts
```

## Limits that remain

- Linux ACCEPT applies only to that pinned archive's offline fence: 74 packaged
  tests plus the independent probes in that review. It is not macOS acceptance,
  not a live GO, and not deployment.
- A writer who can rewrite the canonical sibling anchor can still load a
  substituted book. That trusted-operator exclusion is unchanged.
- macOS `O_EXLOCK` and real `IOPlatformUUID` were not run. The attached Mac
  checklist is design-only and was not executed here.
- No authoritative tree id was in the Linux report. The tree id above comes
  from GitHub and the local object. An independent reviewer still has to
  accept that mapping.
