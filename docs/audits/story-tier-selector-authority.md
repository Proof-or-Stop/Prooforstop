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
| Default Story mode | Repository configuration was `observe`; absent configuration resolved to `off` | Remains `observe` until a separate real-inventory rollout record authorizes the config flip; unconfigured projects remain `off` |
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
| `npm --prefix packages/main run test:dynamic-validation-test-gate` | PASS; real `2 → 1 execute + 1 excluded` fixture | The actual signed PASS enters TEST, reaches the DONE dynamic consumer, and both consumers reject missing/tampered/expired/revoked evidence |
| `npm --prefix packages/main run test:dynamic-validation-test-gate-mutations` | `authority mutations rejected` | A mutated authority prerequisite cannot produce TEST PASS |
| `node scripts/verify-process-fact-contract.mjs` | PASS | The prompt/handler/gate two-layer contract, selector manifest facts, TEST consumer, and independent DONE boundary agree |

The TEST-gate task's stable registered wrapper imports and executes a two-command
repository fixture in the same process. The canonical
baseline executes both commands; the authoritative Story-fast path executes one
and records one signed exclusion. `assessStoredValidationPassAdmissibility` is
called with both admission policies, `runValidateGate` consumes the accepted
record, and `runDoneOracleGate` rechecks it. A changed ledger, missing receipt,
mismatched HEAD, signature mutation, expiry and revocation are independently
refused. The package scripts retain their existing registered command identity;
the wrapper only emits either selector after the real gate fixture completes.

## Claude CLI audit and remediation

The first independent Claude CLI audit inspected commit `491c8e7a65` and
returned `fail` under run `437bd178-d06d-446b-9c2e-a32cf7d1d794`. All fourteen
findings were retained and repaired in the Lab:

| Finding | Before | Repair / evidence |
| --- | --- | --- |
| F1 binding digest | Producer and consumer used different canonicalizers | Both consume `digestCanonicalJson`; the smoke builds the binding through the production builder and tests a mutated decision |
| F2 ownership completeness | Policy defaults accidentally promoted heuristic roots to `complete` | Selector coverage now has explicit provenance; only per-command declared complete roots authorize exclusion; graph edges add positive impact but never upgrade completeness |
| F3 activation default | An unconfigured Story silently entered enforce mode | Unconfigured projects remain `off`; this repository remains in `observe` pending rollout evidence |
| F4 pre-launch defense | Core only re-hashed caller-supplied data | The runtime adapter re-runs the pure selector and compares the complete decision before child launch |
| F5 TEST consumer | Mode-string assertions did not prove stored evidence admission | The real two-command fixture proves signed TEST and DONE admission plus receipt/ledger/signature refusals; canonical consumers explicitly decline dynamic coverage |
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

## Second Claude CLI audit and remediation

The Lab-finish audit of release candidate `4f4220fb3b` returned `fail` under run
`7a42d128-493a-4de6-b50c-8e36722996ed`. The release tool stopped before main
integration. Its eleven findings were retained and repaired as follows:

| Finding | Unsafe or unproven behavior | Repair / executable evidence |
| --- | --- | --- |
| A2-F1 graph completeness | Any non-empty dual graph promoted every command to complete ownership | Only a command's own `inputsComplete + inputRoots` declaration can prove completeness; graph augmentation stays partial and build failures/unresolved imports set graph uncertainty |
| A2-F2 premature activation | Config switched to enforce in the implementation commit without real-inventory shadow evidence | Config is restored to `observe`; activation is a separate rollout change after recorded observation |
| A2-F3 additive selector | Narrow tiers still ran default commands; full tiers destroyed receipt reuse | Manifest now partitions every command and uses signed `excluded` rows for safe omission; full widening preserves admissible receipts |
| A2-F4 TEST/DONE consumers | Dynamic admission defaulted false silently and DONE intent was not explicit | The option is required at every caller; REVIEW, TEST, verdict, certification and DONE consumers opt in explicitly while canonical callers opt out |
| A2-F5 fabricated authority test | Test rewrote escalation fields and re-signed the result | Authority now uses the honest non-escalated production manifest unchanged |
| A2-F6 legacy pin test | No receipts meant default execution could masquerade as compatibility widening | Control plan first proves reuse, then the legacy pin forces execution and records `legacy-validation-pin-unresolved:<pin>` |
| A2-F7 marker-only gate test | Package task only searched a marker in the mutation smoke | The stable package-task wrapper now imports the real signed TEST/DONE fixture; only a successful positive and negative consumer run emits the selector |
| A2-F8 blanket fixture roots | A caller-wide root override implied complete ownership | Overrides affect runtime closure only; selector completeness stays per command |
| A2-F9 orphan comments | Portable identity comments described unrelated symbols | Comments moved beside the portable tuple and cwd implementation |
| A2-F10 unused Story id | Mode resolver accepted a Story id it never read | Removed from the resolver and every call site |
| A2-F11 open-prefix contract | Process-fact assertion accepted any third argument | Exact regex pins `{ allowDynamicCoverage: true }` at the shared gate consumer |

During this repair the real TEST fixture also exposed a remaining legacy ID in
canonical baseline publication. It is now replaced by the same portable
`prov-*` implementation used by planning and execution; without this correction
the baseline inventory/catalog digests could never match and dynamic authority
always fell back to full.

After synchronizing main, a release preflight caught that changing the package
aliases themselves would invalidate version-source dependency evidence and make
the static scanner expand a registered validator through other registered
validators. The aliases were restored byte-for-byte. The existing wrapper now
performs the real fixture import in-process, preserving command identity while
removing the marker-only behavior. Both public npm entries and the complete
process-fact contract pass with that topology.

## Rollback

Set `validate.dynamic.mode` to `off`, or pass `--dynamicMode=off`. The selector,
manifests, receipts, and diagnostics remain readable, but routine validation
returns to complete-plan execution. Static `--focus=fast` compatibility and
independent DONE-required evidence are unchanged.
