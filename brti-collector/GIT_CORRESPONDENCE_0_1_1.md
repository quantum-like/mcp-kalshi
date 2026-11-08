# Git correspondence for collector 0.1.1

The completed 0.1.1 review accepted the offline code and said credential-free
Mac acceptance is not suitable. That review did not contact GitHub. It treated
commit `1180ac7942f2301f4b60f109f61a7af4dee87758` as provenance text inside
`PROVENANCE.json` only.

This later read did contact the public GitHub API. It is an author mapping,
not a second review.

## Object

- Commit `1180ac7942f2301f4b60f109f61a7af4dee87758`
- Parent `af7feb513314418ce028cb629af5e5ba496e9417`
- That parent’s parent is `7e3edacdf1ce8611650ad978f1ef94462eced673`
- Tree `1a90abf70d80b347ca43642f1c3e334eab11378b`
- Local `git rev-parse 1180ac7^{tree}` matches
- `7e3edac` is an ancestor of this branch
- URL: https://github.com/quantum-like/mcp-kalshi/commit/1180ac7942f2301f4b60f109f61a7af4dee87758

## Archive

`/opt/cursor/artifacts/brti-collector-0.1.1-offline.tgz` is 23505 bytes,
SHA256 `5b503dfe317fee19b69fe78cd863e1f7e1eb88234b422d30395a85e3d6c3349a`.

Twenty-one committed `brti-collector/` blobs in that archive match tree
`1a90abf70d80b347ca43642f1c3e334eab11378b`. Three archive-only files were
written at pack time and are not git objects: `PROVENANCE.json`,
`TEST_EVIDENCE.txt`, and `SOURCE_SHA256.txt`. GitHub does not host the tarball.

The accepted 0.1.12 safety archive is unchanged: 7430643 bytes, SHA256
`4bc4dc1773166c37bc654828030b0327304a28c77d65f5227081e4cb1676a558`. Its earlier
57-path mapping and the archive-only `dist/`, `harness/`, and `node_modules/`
limitation are unchanged. This file does not rebuild them.
