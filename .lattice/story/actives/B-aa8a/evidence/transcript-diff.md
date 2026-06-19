# B-aa8a — Real-machine acceptance (auto-bump version on DONE merge)

User-perspective verification: when a story DONE-merges to local main with MATERIAL code
changes, the patch version auto-increments across the 3 sync points (root package.json,
packages/main/package.json, lattice-brand.ts LATTICE_CLI_VERSION) and a `chore: bump` commit
lands on main — no manual bump. A metadata-only merge does NOT bump.

## 5-question user-value self-check

1. **Who / what?** A developer (or autopilot) DONE-merges a story to local main.
2. **What was missing?** No auto version bump existed; the operator had to manually `chore: bump`
   (hit on B-5d18 → manual 0.3.9). The DONE post-merge effect already auto-rebuilt dist but never bumped.
3. **What's delivered?** `bumpVersionOnDoneMerge` runs in the DONE post-merge effect (under the
   merge-lock, before the dist rebuild), gated on the SAME material-change predicate as the rebuild:
   patch-bumps all 3 sync points atomically (rollback on any failure / drift) and commits on main.
4. **How observed?** The merge log prints `✓ version auto-bumped X → X+1 across 3 sync points after
   DONE merge` (or `✓ version bump skipped (no material code change)`), proven by the 64-assertion
   hermetic smoke and the live demo below.
5. **Gap vs need?** None for realistic inputs. Documented accepted limitation: a regex parser cannot
   fully parse TS (a line-start export inside a template literal in the controlled lattice-brand.ts is
   out of scope; the runtime cannot depend on the TS compiler). All realistic modes — line/block
   comments, duplicate/commented-out exports, drift, partial writes, verify failure — are handled + fail loud.

## Expected (from PLAN)

- Material-code DONE merge → `✓ version auto-bumped 0.3.10 → 0.3.11 across 3 sync points after DONE
  merge`; a `git add` of the 3 files + a `chore: bump lattice cli to 0.3.11` commit on main; all 3
  files moved to 0.3.11.
- Metadata-only DONE merge → `✓ version bump skipped (no material code change)`; version unchanged.

## Actual (observed on this machine, 2026-06-19, darwin)

```
# bumpVersionOnDoneMerge against a temp fixture at 0.3.10 (material change, shouldBump=true):
MATERIAL MERGE  => ✓ version auto-bumped 0.3.10 → 0.3.11 across 3 sync points after DONE merge
  git calls     => ["add package.json packages/main/package.json packages/main/src/core/lattice-brand.ts",
                    "-c commit.gpgsign=false commit -m chore: bump lattice cli to 0.3.11"]
  brand now     => export const LATTICE_CLI_VERSION = '0.3.11' as const;

# same, shouldBump=false (metadata-only merge):
METADATA MERGE  => ✓ version bump skipped (no material code change)

# full validate (the smoke is registered as a configured command):
✓ configured validate.commands[6]: node packages/main/dist/tasks/version-bump-smoke.js
  version-bump smoke passed: 64 assertions
```

## Diff (expected vs actual)

None. Actual matches expected on every point: the bump line, the git add of all 3 files, the
`chore: bump` commit message, the bumped brand constant, and the metadata-only skip line.
`lattice validate --story=B-aa8a` reports verificationCoverage covered=28/28, missingRequired=0.

## Dual-host review

Genuine cross-provider review over 5 rounds: Claude (concept/quality/test-coverage) + Codex host-2
(`codex exec`). Codex caught 6 real MAJORs across rounds 1–3 that materially hardened the parser —
substring→structural JSON, regex-anywhere→line-anchored + comment-stripped, and two rollback gaps
(post-write-verify throw, partial write). Round 5: both hosts PASS, 0 findings; 7 findings
(F-001..F-007) all resolved.
