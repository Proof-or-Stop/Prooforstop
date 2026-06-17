# Execution plan: B-292d (koala-residue preflight gate)

## Order
1. **CHK-001** — Add `KOALA_RESIDUE_GATE_LABEL` const + `runKoalaResidueGate()` helper + dispatch entry + union-type slot in `packages/main/src/handlers/review-preflight.ts`. Mirror english-artifacts pattern byte-for-byte. Run `npm --prefix packages/main run build`.
2. **CHK-002** — Update `packages/main/src/cli-prompts.ts:267-273` REVIEW→TEST PREFLIGHT block to list 7 gates (add the previously-missing english-artifacts + the new koala-residue). Update CLAUDE.md line 35 and line 809 gate lists. Rebuild dist.
3. **CHK-003** — CHANGELOG Unreleased entry under "Test infrastructure" subsection referencing B-292d + the new gate. Update `~/.claude/projects/-Users-jek-Documents-CDR3/memory/koala-removal-ship-clean-program.md` to mark story 4 DONE and correct the stale 7-hit claim.

## Dependencies
- CHK-001 must come before CHK-002 (the new gate name must exist before the help text references it).
- CHK-002 must come before CHK-003 (CHANGELOG describes the final shape).
- Memory edit is OUTSIDE the gated story flow (auto-memory is not under Lattice scope-contract).

## Verify
- `npm --prefix packages/main run build` after CHK-001 (TS must compile cleanly).
- `node bin/lattice.js review_preflight --storyId=B-292d` (or check the rebuilt dist line by grep) to confirm new gate is dispatched.
- `npm test` (root chain unchanged + still includes test:koala-residue).
- `npm --prefix packages/main run test:run-all-smokes-smoke` (runner self-smoke).
- Create a small fixture file with literal `Koala-` token + retry preflight → expect BLOCK.
- Remove the fixture → expect PASS.

## Out of scope (explicit)
- `scripts/verify-koala-residue.mjs` (byte-frozen)
- `packages/main/smoke-manifest.json` (frozen by B-d7c3)
- `lattice validate` default-battery handlers (excluded per user option (a))
- root `package.json` `test:koala-residue` (kept per user sub-decision (a3))
- `.koala/` runtime-dir rename, `LEGACY_KOALA_*` path constants, `docs/koala/framework-audit/` (deferred per memory)
