# Scoped audit — validate-resource-claims test-only delta (c750ab3c11..HEAD)

**Verdict: PASS** (bounded to `packages/main/tests/validate-resource-claims.test.mjs` at HEAD 65bd543535fa917ae4dc60af6548d3554cb2ab24).

## Scope of the delta
`git diff --name-status c750ab3c11..HEAD` returns exactly one path:
`M packages/main/tests/validate-resource-claims.test.mjs` (23 insertions, 11 deletions, single commit
`65bd543535 test: verify explicit admission conflicts and quorum observation isolation`).
No scheduler, mutation-detector, production or config file is touched. Working tree is clean.

Cumulatively since the previously closed disposition point `3da2f2f4`, the only non-documentation
change is this same test file; `docs/` and `experiments/` additions are evidence/documentation only.
Production/config therefore remains as audited.

## Assertion-level assessment

### Item 6 — declared configured readers
Removed: `the declared configured commands are mutually compatible` (blanket "no declared pair may conflict").
Added two assertions:
1. `the configured plan retains at least two admission readers and independent readers` —
   `overlappable.filter(takesAdmission).length >= 2 && overlappable.filter(!takesAdmission).length >= 2`.
2. `declared readers serialize exactly the audited admission pairs and otherwise remain compatible` —
   for every unordered pair: `claimsConflict(entry, other) === (takesAdmission(entry) && takesAdmission(other))`.

`takesAdmission` is pinned to the exact triple `class === 'runtime-lock'`,
`key === 'proof-or-stop-real-root-admission'`, `access === 'exclusive'` — it cannot be satisfied by an
unrelated or weaker claim.

This is **not** a suppression. It is a biconditional, so it retains the full force of the old check on
every non-admission pair (those must still be compatible) and *adds* a positive obligation that every
admission pair actually conflicts. The old assertion was the contradictory one: it demanded that
holders of a genuine exclusive mutex be mutually compatible. A pair that both hold an exclusive
`runtime-lock` on the same key must conflict under any sound conflict relation; the new form models the
already-audited common admission mutex instead of denying it. The `>= 2 / >= 2` guard prevents the
biconditional from going vacuous if a future edit empties either side, so neither branch can be
trivially satisfied.

### Item 7 — quorum smoke
- `jobs=2` is retained verbatim in the exact-args comparison.
- `exactDeclaration` now requires resources to serialize exactly as `[REPO_READ, outerBarrier]` where
  `outerBarrier = { class: VALIDATE_PLAN_BARRIER_CLAIM_CLASS, key: VALIDATE_PLAN_BARRIER_CLAIM_KEY,
  access: 'exclusive' }` — exact shared Git claim plus exact exclusive outer observation barrier,
  no more and no less.
- Resolution check tightened from 2 to 3 resources and now asserts
  `isBarrier(resolved.resources[2], 'exclusive')` in addition to the shared barrier and the unchanged
  `REPO_READ` class/key/access triple.
- New: `quorum protected-root observation excludes every other local validation writer` — resolves and
  canonicalizes the **whole configured plan** and requires `claimsConflict` against every other entry.
  This is an actual conflict assertion over real config, not a declaration-shape assertion.
- Refusal guard broadened from one negative case to three: **missing** barrier (`[REPO_READ]`),
  **wrong** access (`REPO_READ` exclusive + barrier), and **extra** claim. All three must be rejected.

Net effect for item 7: strictly more binding than the prior "raw shared claim only" form.

### Preserved generic coverage
All generic execution tests survive unchanged — the diff contains no +/- line touching them, and the
run emits every one of their markers:
`DISJOINT-DECLARED-CONCURRENT`, `UNDECLARED-SINGLE-EXCLUSIVE-CLAIM`, `UNDECLARED-NEVER-OVERLAPS`,
`UNKNOWN-CLASS-REFUSED`, `UNKNOWN-CLASS-REFUSED-IN-CONFIG`. The fail-closed structural assertions
(undeclared ⇒ single exclusive barrier; empty `resources` treated as undeclared, not "touches nothing";
caller-supplied `canonicalKey` discarded; barriers overlap nothing) are untouched, as are
`AUDITED-BARRIERS-HELD` (8 commands) and `COLLISION-PROBE-BITES`.

The test defines no local `claimsConflict` (local definitions found: 0; 5 import statements),
so conflict decisions are evaluated by the production relation rather than a test-local restatement —
the new assertions are bound to real behavior. See `evidence/verification-context.log`.

## Executed test (unmodified)
```
$ node packages/main/tests/validate-resource-claims.test.mjs
exit 0
validate-resource-claims: PASS (48 assertions)
```
stderr was empty. Configured plan observed: 141 commands, 141 declared, 0 exclusive by fail-closed default.
Complete stdout/stderr/exit are in `evidence/`.

## Bound hashes
| Artifact | SHA-256 |
| --- | --- |
| `packages/main/tests/validate-resource-claims.test.mjs` (HEAD) | `713e14efe3a28a4c4181b1fffd14ca9656e7ad7d65005586d1dbc243b2af39fc` |
| `evidence/validate-resource-claims.stdout.log` | `e35b7a05a97e32280e9148d67c92c241918395abbe1f4c81c21a4d0307bbdb9f` |
| `evidence/validate-resource-claims.stderr.log` (empty) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `evidence/validate-resource-claims.exit` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` |
| `evidence/verification-context.log` | `b0d06534c8047dc999ded58a7f09cd38272f6abfd1a6240bbf90efe301899e8e` |

Original failure reference: `/Users/jek/.codex/artifacts/proof-or-stop-five-item-integration-20260909/native-green/21/stderr.log`.

## Bounds
Verdict covers only this one test file, its delta since `c750ab3c11`, and this single execution. No other
suite was run; no full-141 claim and no Story-wide performance claim is made here. Prior audit
invariants remain as previously bounded.
