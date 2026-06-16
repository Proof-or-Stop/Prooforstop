# B-08f2 — Real-machine user-acceptance transcript & diff

**Commit:** `d48ea8063` (story/B-08f2)

## Expected (PLAN outcome)
No KOALA_* env var a user would set/read remains in active code/config/wrapper-assets/hook-docs/tests.
An operator who used to `export KOALA_AGENT=...` now exports `LATTICE_AGENT=...`. build + e2e green.

## Actual (observed)
```
$ git grep -nE 'KOALA_[A-Z]' (active files; excl deferred-legacy/.koala/CHANGELOG/experiments/decisions) | grep -v whitelist
   → 0 in-scope KOALA_ env tokens remaining

$ git grep -nE '(\|\||\?\?)\s*process.env.KOALA_'        → 0  (no fallback shim left)
$ git grep -c LEGACY_KOALA_ -- core/lattice-paths.ts        → packages/main/src/core/lattice-paths.ts:7  (deferred .koala path constants preserved)
$ ls docs/koala/legacy | wc -l                              → 0  (archive dropped)
$ ls docs/koala/framework-audit | wc -l                     → 7  (active path kept)
$ npm run build                                             → exit 0
$ npm run test:e2e                                          → exit 0, ALL PASS
$ node bin/lattice.js validate                              → PASS, 36/36 intent coverage
$ node bin/lattice.js verify_codex                          → 8/8 pass (global CLI relinked to renamed dist)
```

## Diff (expected vs actual)
No gap. The KOALA_* env-var contract is fully renamed to LATTICE_*: 17 dual-read fallbacks dropped,
38 KOALA-only vars renamed across reads/setters/configs/.Codex+.claude assets/hook docs/tests, plus
all active-doc env references (README, CLAUDE.md, guide.md, guide-hooks.md, audits). The deferred
`.koala` path layer (LEGACY_KOALA_* constants) is untouched; docs/koala/framework-audit kept;
docs/koala/legacy archive dropped.

## Known follow-ups (deferred, out of scope)
- F-001 (dismissed): 4 decision-doc historical-lineage refs to the removed docs/koala/legacy/ → active-docs sweep (story 4).
- Broader `koala` PROSE in CLAUDE.md/README/decisions, and the `.koala` runtime-dir rename → later program stories.
- Global `lattice` CLI must be rebuilt/relinked from main after this merge (it was npm-linked to main's old dist).

## User-value self-check
- Does the user see the intended result? Yes — no KOALA_ env vars in the layer; LATTICE_* is the contract.
- Run on a real machine? Yes — grep/build/e2e/validate/verify_codex in the story worktree.
- Breaking change acknowledged? Yes — external KOALA_* exporters must switch to LATTICE_* (no users yet).
