# Story-tier selector authority Lab log

## Scope and design binding

This Lab implements the approved execution order for Story-aware validation
tiers. It does not change or complete Story B-0aa0. The design input is bound to:

- B-0aa0 commit: `08ca1a7ca0a9fe25132e4b6df6a02bd185fa7264`
- Design document: `docs/requirements/decisions/story-relevance-dynamic-validation-tiers-execution-plan.md`
- Design document SHA-256: `2b696619d728a43713cdd2bdc5dfc4455e9a4f9e6bee7773139a645bc1df80b8`
- Lab base main: `3d4aaca54447830fbc4e407d6dfcc21b436d1683`

The implementation preserves two separate axes: fast/intermediate/full are
membership tiers, while off/observe/shadow/enforce-low-risk are rollout and
authority modes. Dynamic Finding remains a scope/finding constraint input; it
does not become a validation tier and cannot authorize scope expansion.

A documentation Story is not fast merely because its file suffix is Markdown.
It is fast only when the current catalog/graph proves a non-empty local docs
membership and proves every omission; a shared documentation contract promotes
it to intermediate. An unmatched docs path, a process-changing policy document,
or an incomplete declaration widens to repository-full. This avoids replacing
the old fixed 168-command rule with a new unsafe “all docs are cheap” rule.

## Before and after

| Concern | Before | After |
| --- | --- | --- |
| Static fast focus | 16 of 168 configured commands | Preserved for compatibility; no longer the Story-aware selector |
| Story tier selection | Canonical pure selector existed, but the production executor used a separate relevance calculation | Production catalog is projected into the canonical selector and the executor consumes that exact decision |
| Tier choice | Operator had to request fast/intermediate/full; no automatic promotion | Starts at fast, promotes to intermediate for directly affected shared/boundary rows, and widens to full for risk, gate, validation-infrastructure, unclassified, stale, or incomplete inputs |
| Stable command identity | Explain planner used declared/provisional IDs; runtime generated a separate `validation-*` ID | Both use the declared ID or the same portable `prov-*` identity |
| Decision binding | Runtime manifest had no canonical tier arrays or selector digest | Signed manifest binds requested tier, effective tier, all three exact ID arrays, and `selectorDecisionDigest` |
| Pre-launch mutation defense | No cross-path selector digest to compare | Runtime recomputes the binding digest and verifies exact full-universe plus tier-subset membership invariants before child execution |
| Default Story mode | Repository configuration was `observe`; absent configuration resolved to `off` | Story-scoped validation defaults to configured `enforce-low-risk`; project-level validation remains `off` by default |
| TEST | Verifier forced every TEST invocation to dynamic `off` | TEST may accept dynamic authority only with a complete inventory partition and all existing baseline/closure/freshness/expiry/revocation prerequisites |
| Explicit full and DONE | Complete canonical policy | Unchanged: explicit `--full` and DONE resolve dynamic mode to `off`; DONE-required commands remain independent |
| Missing authority prerequisites | Complete plan fallback | Unchanged: known preflight rejection falls back once before dynamic children run |
| Host without Bun | Dynamic audit wrapper failed with null process status | It runs the same compiled registered smoke with Node when Bun is absent |

## RED

RED commit: `f1500cd0d6` (`test: require automatic validation tier authority`).

Command:

```text
sh -c 'npm --prefix packages/main run build && node packages/main/dist/tasks/validation-tier-planner-smoke.js'
```

Recorded result: exit 2. The compiler reported that
`buildValidationImpactIndexFromCatalog` and `selectAutomaticValidationTier`
were not exported. This is the target failure: production catalog projection
and automatic tier choice did not exist.

## GREEN and safety evidence

| Command | Result | What it proves |
| --- | --- | --- |
| `npm --prefix packages/main run build` | PASS | TypeScript implementation and generated runtime build compile |
| `npm run test:validation-tier-planner` | PASS; CHK-004 30 cases, CHK-005 20 cases | Dynamic tier sets, automatic docs promotion, fallback, CLI reporting, and subset invariants |
| `npm --prefix packages/main run test:story-aware-validation` | PASS | Runtime manifest consumes and binds the canonical selector decision |
| `npm --prefix packages/main run test:story-aware-validation-mutation` | PASS; 30 replay classes and FI-1..FI-5 | Digest, catalog, receipt, closure, selection, scheduler, and shard mutations fail safely |
| `npm --prefix packages/main run test:dynamic-validation-selection` | `complete ledger PASS` | Every inventory member is accounted for |
| `npm --prefix packages/main run test:dynamic-validation-selection-mutations` | `monotonicity PASS` | Expanding Story impact cannot shrink the selected set |
| `npm --prefix packages/main run test:dynamic-validation-test-gate` | `low-risk dynamic TEST PASS` | TEST authority is possible only through the existing complete logical-coverage contract |
| `npm --prefix packages/main run test:dynamic-validation-test-gate-mutations` | `authority mutations rejected` | A mutated authority prerequisite cannot produce TEST PASS |
| `node scripts/verify-process-fact-contract.mjs` | PASS | The prompt/handler/gate two-layer contract, selector manifest facts, TEST consumer, and independent DONE boundary agree |

The first isolated process-fact run exposed a dependency cycle caused by loading
the high-level planner from the low-level Story-aware core. The implementation
was corrected by extracting portable command identity to a side-effect-free
module and keeping the planner dependency out of the low-level runtime core.
`CERTIFICATION_MUTATOR_PIN_GREEN` and the complete process-fact contract then
passed. A separate missing-`typescript` result was a fresh-worktree dependency
setup issue; installing the already locked root dependencies resolved it without
changing package manifests or lockfiles.

## Rollback

Set `validate.dynamic.mode` to `off`, or pass `--dynamicMode=off`. The selector,
manifests, receipts, and diagnostics remain readable, but routine validation
returns to complete-plan execution. Static `--focus=fast` compatibility and
independent DONE-required evidence are unchanged.
