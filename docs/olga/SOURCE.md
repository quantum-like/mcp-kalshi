# Source recovery

The 0.1.5 release pack reviewed in the attached assessment contains compiled `dist/` and the offline harness. It does not contain `src/`. This work continues from the git tree that produced that pack:

- Repository: `https://github.com/quantum-like/mcp-kalshi`
- Branch: `cursor/a1-readiness-5a91`
- Safety-repair parent: `917dff61dbac00aceee9bb1cde11d71b96f739e0`
- Original TypeScript pin: `e75202e92e50c62f88eee3e26b68cd7a06dffc24`
- Pull request: `https://github.com/quantum-like/mcp-kalshi/pull/2`

`dist/strategy/ledger.js` at that pin hashes to `8ef5a9e2680c632c7aa8408ab5a1e0eb9abf6642d625a3653130cc14eec88f26`, the same digest as `artifact/dist/strategy/ledger.js` in the attached manifest. The Olga files are new TypeScript beside that tree. They are not a rewrite inferred from the compiled bundle.

a2 migration and diligence stay on hold. This change does not select the a2 profile and does not edit the deployed 0.1.2 connector.
