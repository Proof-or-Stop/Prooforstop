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
| Pre-launch mutation defense | No cross-path selector digest to compare | Runtime re-runs the pure selector, recomputes the binding digest, and verifies exact full-universe plus tier-subset membership invariants before child execution |
| Default Story mode | Repository configuration was `observe`; absent configuration resolved to `off` | Unconfigured projects still resolve to `off`; this repository explicitly configures `enforce-low-risk` for DEV/REVIEW/TEST only |
| TEST | Verifier forced every TEST invocation to dynamic `off` | TEST may accept dynamic authority only with a complete inventory partition and all existing baseline/closure/freshness/expiry/revocation prerequisites |
| Explicit full and DONE | Complete canonical policy | Unchanged: explicit `--full` and DONE resolve dynamic mode to `off`; DONE-required commands remain independent |
| Missing authority prerequisites | Complete plan fallback | Unchanged: known preflight rejection falls back once before dynamic children run |
| Host without Bun | Dynamic audit wrapper failed with null process status | It first performs the canonical build, reports the Node artifact path, then runs that freshly emitted registered smoke |

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

The TEST-gate mutation task now drives `storedDynamicReceiptIntegrityReasons`
against a real one-command signed baseline, closure, receipt, manifest and
revocation ledger. The valid complete ledger is accepted; a changed ledger, a
missing receipt and a mismatched HEAD are independently refused. Its public
markers are therefore backed by the stored-evidence consumer rather than by
marker-only assertions.

## Claude CLI audit and remediation

The first independent Claude CLI audit inspected commit `491c8e7a65` and
returned `fail` under run `437bd178-d06d-446b-9c2e-a32cf7d1d794`. All fourteen
findings were retained and repaired in the Lab:

| Finding | Before | Repair / evidence |
| --- | --- | --- |
| F1 binding digest | Producer and consumer used different canonicalizers | Both consume `digestCanonicalJson`; the smoke builds the binding through the production builder and tests a mutated decision |
| F2 ownership completeness | Policy defaults accidentally promoted heuristic roots to `complete` | Selector coverage now has explicit provenance; only declared roots or a complete dual-revision graph can authorize exclusion; a defaults-only regression widens full |
| F3 activation default | An unconfigured Story silently entered enforce mode | Unconfigured projects remain `off`; this repository opts in through config |
| F4 pre-launch defense | Core only re-hashed caller-supplied data | The runtime adapter re-runs the pure selector and compares the complete decision before child launch |
| F5 TEST consumer | Mode-string assertions did not prove stored evidence admission | A real signed stored baseline/manifest/receipt/ledger matrix now proves valid admission and three independent refusals; dynamic coverage is explicit at REVIEW-to-TEST and forbidden for canonical consumers |
| F6 decision digest | Automatic promotion omitted exclusion/inclusion evidence and mixed requested tiers | Intermediate promotion now reports intermediate consistently and its digest includes exclusion proofs and inclusion reasons; proof changes alter the digest |
| F7 command digest / legacy pin | Portable hashing was duplicated and legacy `validation-*` pins could disappear | One exported digest implementation serves both identity paths, a literal vector pins its bytes, and legacy runtime pins widen to the full current inventory |
| F8 cwd/shell identity | Config discovery omitted cwd/shell when deriving an ID | Both discovery paths hash the full narrow tuple; a cwd+shell regression proves identical IDs |
| F9 manifest mutations | The contribution mutation removed an ID from every source and did not cover tier fields | A single-source canonical contribution and re-signed tier subset/full-universe/missing-field mutations are each rejected |
| F10 Node fallback | Node could run stale compiled smokes | The fallback runs the canonical build first and reports runtime, artifact and freshness basis |
| F11 patch version | The repair commit itself had no version bump | Lab finish owns the atomic patch bump, both manifests, both lockfiles, CLI brand, build and post-bump Claude audit; version changes are intentionally not hand-edited before finish |
| F12 broad error regex | Two unrelated Git failures could satisfy each assertion | Each fixture now requires the exact immutable-object resolution refusal emitted on this Node 26 / Git host |
| F13 incomplete graph | A half-resolved graph could contribute selector roots | `graphUnknown` contributes no roots and has a regression assertion |
| F14 stale contract text | Planner/header and process-fact verifier described only the old explain path | Text and mechanical token checks now cover the automatic selector, binding builder, catalog projection and complete-coverage guard |

The mandatory Lab-finish audit runs against the generated release candidate,
after the tool-owned patch version commit exists. A passing standalone audit of
the pre-release repair head would be misleading for F11 and is not substituted
for that post-bump audit.

The first isolated process-fact run exposed a dependency cycle caused by loading
the high-level planner from the low-level Story-aware core. The implementation
was corrected by extracting portable command identity to a side-effect-free
module and keeping the planner dependency out of the low-level runtime core.
`CERTIFICATION_MUTATOR_PIN_GREEN` and the complete process-fact contract then
passed. A separate missing-`typescript` result was a fresh-worktree dependency
setup issue; installing the already locked root dependencies resolved it without
changing package manifests or lockfiles.

The exact Git-ref assertions use the current host's
`Git references did not resolve to two immutable objects` result. This replaces
the earlier broad alternation; it does not treat another early refusal as proof
of the intended case.

## Rollback

Set `validate.dynamic.mode` to `off`, or pass `--dynamicMode=off`. The selector,
manifests, receipts, and diagnostics remain readable, but routine validation
returns to complete-plan execution. Static `--focus=fast` compatibility and
independent DONE-required evidence are unchanged.
