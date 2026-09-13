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

## GREEN and developer-run safety evidence

Only the pinned build-plus-planner command is the Lab tool-owned GREEN receipt.
The remaining rows are developer-run supporting checks at the repair commits;
they are not relabelled as Lab-owned evidence or as post-bump receipts.

| Command | Result | What it proves |
| --- | --- | --- |
| `npm --prefix packages/main run build` | PASS | TypeScript implementation and generated runtime build compile |
| `npm run test:validation-tier-planner` | PASS; CHK-004 32 cases, CHK-005 21 cases | Dynamic tier sets, automatic docs promotion, fallback, CLI reporting, and subset invariants |
| `npm --prefix packages/main run test:story-aware-validation` | PASS | Runtime manifest consumes and binds the canonical selector decision |
| `npm --prefix packages/main run test:story-aware-validation-mutation` | PASS; 30 replay classes and FI-1..FI-5 | Digest, catalog, receipt, closure, selection, scheduler, and shard mutations fail safely |
| `npm --prefix packages/main run test:dynamic-validation-selection` | `complete ledger PASS` | Its mode-specific assertion reconstructs and verifies complete inventory accounting |
| `npm --prefix packages/main run test:dynamic-validation-selection-mutations` | `monotonicity PASS` | Its mode-specific assertion rechecks that the contribution mutation is rejected |
| `npm --prefix packages/main run test:dynamic-validation-test-gate` | PASS; real `2 → 1 execute + 1 excluded` fixture | The actual signed PASS enters TEST, reaches the DONE dynamic consumer, and both consumers reject missing/tampered/expired/revoked evidence |
| `npm --prefix packages/main run test:dynamic-validation-test-gate-mutations` | `authority mutations rejected` | Its mode-specific assertion rejects mutated authority, then the real TEST/DONE fixture runs its negative matrix |
| `node scripts/verify-process-fact-contract.mjs` | PASS | The prompt/handler/gate two-layer contract, selector manifest facts, TEST consumer, and independent DONE boundary agree |
| `node scripts/verify-validation-static-edges.mjs` | `U18_STATIC_PASS`; 326 exceptions, 0 needs-review, 0 nested | Every retained nested-execution exception still has current source and dependency evidence |
| `node scripts/verify-validation-static-edge-boundaries.mjs` | `U18_STATIC_EDGE_BOUNDARIES_PASS` | Stale, missing, moved, altered, escaping, and incomplete static evidence is refused |

The TEST-gate task's stable registered wrapper imports and executes a two-command
repository fixture in the same process. The canonical
baseline executes both commands; the authoritative Story-fast path executes one
and records one signed exclusion. `assessStoredValidationPassAdmissibility` is
called with both admission policies, `runValidateGate` consumes the accepted
record, and `runDoneOracleGate` rechecks it. A changed ledger, missing receipt,
mismatched HEAD, signature mutation, expiry and revocation are independently
refused. Compatibility package entrypoints remain, but the mutation task now
dispatches twenty distinct mode-specific executable assertion blocks instead of
relabeling one unconditional tail marker. TEST-gate modes additionally run the
real TEST/DONE fixture. These package entrypoints are not twenty configured
`validate.commands` rows and therefore do not inflate Story runtime selection.

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

The first isolated process-fact run exposed a dependency cycle around portable
command identity. The implementation was corrected by extracting that identity
to a side-effect-free module. The signed-manifest verifier later gained a narrow
dependency on the planner's pure selector so it can reconstruct, rather than
trust, persisted exclusion decisions; it does not import execution handlers.
`CERTIFICATION_MUTATOR_PIN_GREEN` and the complete process-fact contract pass.
A separate missing-`typescript` result was a fresh-worktree dependency
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
| A2-F4 TEST/DONE consumers | Dynamic admission defaulted false silently and DONE intent was not explicit | The option is required at every caller. All current production consumers opt in explicitly; any future canonical-only consumer must opt out explicitly rather than inherit a default |
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

## Third Claude CLI audit and remediation

The exact-head Claude CLI audit of `b636492a64` returned `fail` under run
`03039e40-10c1-4e2c-836b-82f2f3beb211` after 594,085 ms. It confirmed the
portable command identity, per-command completeness, graph uncertainty,
explicit dynamic-consumer opt-in, and real TEST/DONE fixture repairs, then
identified two remaining high-risk binding gaps and nine consistency/test/performance
issues. The audit record is retained under the Git-common-metadata Lab audit
directory; none of its findings was discarded.

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A3-F1 selector context binding | A self-consistent caller binding could describe a different catalog or omit a changed path | The binding includes the executor catalog digest; prepare compares the live graph-augmented index, catalog, exact command universe and changed paths, while stored admission rechecks the signed base/head dependency-graph digest plus that same current catalog/universe/path contract without fabricating a scope-free Story manifest |
| A3-F2 durable exclusion proof | Signed manifests kept tier arrays but discarded the proofs behind excluded commands | The complete selector binding, including snapshot/index-bound exclusion proofs, is now signed; manifest verification reconstructs the pure selector and stored TEST/DONE admission rechecks it against the current catalog/change set |
| A3-F3 executor-only widening | A wave-0, never-reuse, finding-required, or otherwise forced row outside the tier invalidated the whole manifest | Only omissions are constrained: every excluded row must be outside the effective tier with a current proof; extra executed rows safely widen the plan. A wave-0 command outside fast is an explicit positive control |
| A3-F4 full escalation accounting | Escalation could retain reuse while hard-zeroing coverage gaps on the stale claim that every command was selected | Full escalation again selects every catalog row for execution; the regression asserts the full disposition and escalation reason |
| A3-F5 TEST documentation | One paragraph still called direct TEST validation canonical-full | It now states that configured dynamic authority may apply in TEST only with the complete prerequisite set; explicit full and DONE stay canonical |
| A3-F6 activation claims | Shared help and L4 rationale incorrectly claimed this repository was already in enforce mode | Help is repository-neutral; the L4 fact says unconfigured is off and each repository must opt in only after current rollout evidence. This repository remains observe |
| A3-F7 missing mutations | Excluded/effective-tier, wave-0 widening, and DONE marker stripping were not all exercised | Re-signed mutations cover excluded-inside-tier, excluded-under-full, missing proof and tier invariants; the real DONE consumer now rejects stripped markers and tampered signatures |
| A3-F8 unauthenticated DONE branch | DONE used an unsigned output marker to decide whether to authenticate dynamic evidence | Every stored PASS is authenticated first; a refusal is appended as a blocking DONE checklist row so the rest of the checklist remains visible |
| A3-F9 explain-plan cost | `validation_plan` built a dual-revision whole-repository graph per query | It now uses the same pure selector function over an explain-side catalog projection without runtime graph augmentation; the runtime executor separately retains its safety graph for positive impact and fail-closed escalation |
| A3-F10 digest domain drift | Intermediate promotion redundantly rebuilt an equivalent decision with a third digest body shape | The automatic selector returns the canonical promoted decision directly |
| A3-F11 accounting shape | Runtime JSON emitted `excluded`, but its TypeScript accounting declaration omitted it | `excluded` is now a declared field and covered by the real `2 -> 1 execute + 1 excluded` fixture |

The repairs passed the TypeScript build, Story-aware smoke, all 30 replay mutation
classes, the real TEST/DONE admission suite, and the complete L4 process-fact
contract before a new GREEN was recorded. A new exact-head Claude audit is still
required after this repair commit; Lab finish will also audit the tool-generated
post-version-bump candidate.

## Fourth Claude CLI audit and remediation

The exact-head audit of `fb4106bc48` returned `fail` under run
`505ad0dd-17cd-4b8f-870f-7dfec7d67608` after 595,795 ms. It confirmed that the
selector is now bound to the executor catalog/inventory/change set, the decision
is reconstructed, graph-affected commands execute, and portable identity and
per-command completeness remain sound. Its twelve follow-up findings were
retained and repaired:

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A4-F1 admission catalog parity | Stored admission used a second partial config parser, losing focus/optional/reuse fields and choosing another default label | Inventory discovery now delegates to the same `normalizeConfiguredValidationCommands` used by execution. The real fixture includes focus, optional, and an omitted label and still crosses TEST/DONE |
| A4-F2 marker-only package tasks | Gate modes returned before the core and mutation smokes, while the consumer fixture printed both public markers | The wrapper now requires the complete core and mutation smokes to finish first, then runs the real TEST/DONE fixture, and itself emits the registered selector only after both layers pass; unconditional smoke-tail selector markers were removed |
| A4-F3 observe-mode TEST cost | `observe` in TEST disabled shared reuse and built the dual-revision graph despite no authority activation | TEST preserves `off` semantics for `observe`/`shadow`; only explicit `enforce-low-risk` enables dynamic TEST authority. Non-authoritative modes retain shared execution |
| A4-F4 catalog digest mirror | Generic manifest verification reconstructed the selector but did not compare its catalog digest to the execution manifest | `selectorBinding.catalogDigest` must equal signed `manifest.catalogDigest`; a re-signed unrelated-catalog mutation is rejected |
| A4-F5 DONE contract wording | The DONE consumer accepted signed dynamic evidence while L4 prose could be read as requiring a new full run | The contract now distinguishes evidence consumption from execution: DONE may admit the signed complete dynamic ledger, while explicit full, DONE-phase execution, and DONE-required evidence remain canonical |
| A4-F6 DONE thrown assessment | An exception before checklist construction could hide all other DONE rows | Assessment exceptions become the same blocking row; a one-shot injected exception proves the full rendered DONE checklist still contains the failure |
| A4-F7 escalation documentation | One paragraph said full widening preserved receipts | It now states the implemented conservative rule: repository-full escalation executes every catalog row and reuses none |
| A4-F8 graph augmentation reachability | Graph augmentation existed only in a smoke | Production selector input, executor pre-launch recheck, and stored-evidence recheck all use the same augmentation. Graph edges add positive impact but never upgrade completeness |
| A4-F9 empty-fast intermediate | The automatic selector returned full before testing a directly matching intermediate-only row | When the sole fast refusal is empty selection, the selector tries intermediate; a no-always/no-pin fixture proves `story-intermediate` rather than full |
| A4-F10 legacy pin provenance | Any correctly shaped legacy id appeared caller-shaped | The plan now authenticates the complete current Story change manifest before reading pins; only pins from that signed artifact can take the conservative full-compatibility path |
| A4-F11 mutation precision | Two full-manifest mutations failed first at generic decision recomputation | The standalone verifier separately exercises membership refusal and, with a canonical binding plus a forged narrower manifest tier, reaches the missing-proof predicate. The proof-removal mutation remains an end-to-end recomputation check |
| A4-F12 repeated relevance collection and version | One run could resolve the same tier binding up to three times; the repair head was not yet version-bumped | The prepared signed binding is passed through both execution preparations and reused after Wave-0. The atomic patch version remains owned by Lab finish so both manifests, lockfiles, CLI brand, build, and post-bump audit move together |

The repaired head must receive a new GREEN. Lab finish will create the patch
candidate and run the mandatory different-vendor audit over the exact bumped
commit; a pre-bump audit is not substituted for that release-candidate check.

## Fifth Claude CLI audit and remediation

The Lab-finish audit of release candidate `898a4383b2` returned `fail` under run
`55c40805-78c5-49f8-b43c-3a78268252af` after 573,680 ms. The release tool
stopped before local-main integration and the candidate was reopened, so the
failed candidate did not change `main`. All ten findings were retained and
repaired on the Lab branch:

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A5-F1 unconditional exclusion proof | A signed manifest with excluded rows but no selector binding skipped the exclusion verifier | Exclusion verification is unconditional; a re-signed proofless exclusion without tier fields is rejected |
| A5-F2 whole-repository closure | Catalog projection ignored `closurePolicy`, allowing narrow positive exclusion of a whole-tree command | `whole-repository` projects to `repository-full`, always participates, and contradictory narrow-complete catalog declarations are invalid; the smoke proves the row executes |
| A5-F3 full-only and risk floor | An exact-epoch `full-only` row could be excluded and excluded non-local rows disappeared from authority risk | Every `full-only` row must execute or present an admissible receipt; authority risk considers the complete catalog, so excluded gate/validation-infra rows cannot lower risk |
| A5-F4 stored selector negatives | Stored TEST/DONE admission had only a positive selector-binding case | Re-signed missing-binding and changed-live-catalog cases prove `dynamic_selector_binding_missing` and `dynamic_selector_context_changed` |
| A5-F5 DONE evidence-read exception | `readTestEvidence` could throw before the rendered DONE checklist existed | Evidence read and admissibility are inside one guard; injected `readTestEvidence` failure appears as a blocking row in the complete rendered checklist |
| A5-F6 shared-execution behavior | The observe/shadow predicate change was implicit and untested | A named helper pins off/observe/shadow/enforce behavior and explicit opt-in; DEV/REVIEW consequences are documented |
| A5-F7 catalog digest domain | Manifest and selector binding used separate canonical-digest entry points | Production baseline, preparation, receipt admission, input digest and manifest binding all use `digestCanonicalJson(catalog)` |
| A5-F8 malformed selector input | Hostile non-array impact entries could make a boolean verifier throw | Tier arrays, tier names, universe IDs, pins and changed paths are type-checked and the complete verifier catches malformed signed shapes, returning `false`; authority evaluation additionally converts refusal to `selection-manifest-invalid` |
| A5-F9 dependency seam | Sorted call arities lost the identity of the authorized seam argument | AST regression separately pins one public one-argument call and three internal calls whose second argument is exactly the `dependencies` identifier |
| A5-F10 wrapper markers | Public modes trusted unconditional marker strings printed at the mutation-smoke tail | Tail markers were removed. Every public mode requires the complete core and 30-class mutation smokes; TEST modes additionally run the real signed TEST/DONE fixture, and the adapter emits the requested marker only after those proofs pass |

The repaired source build, planner smoke, Story-aware smoke, 30-class mutation
audit, real TEST/DONE fixture and dynamic admission mutations pass. A fresh Lab
GREEN and a new post-version-bump Claude audit remain mandatory before finish.

## Sixth Claude CLI audit and remediation

The Lab-finish audit of candidate `04c80f7bf2` returned `fail` under run
`36cf4169-e4a8-4c91-958f-9388d0d550dc` after 754,208 ms. Finish stopped before
main integration and the candidate was reopened. The audit confirmed the core
selector binding, unconditional exclusion proof, exact-universe reconstruction,
full escalation, declared-only completeness, conservative risk floor and atomic
version bump, then reported seven remaining integration/evidence issues:

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A6-F1 bindingless atomic source | A bindingless zero-exclusion manifest could be rejected even though it omitted nothing, creating a future deadlock if an atomic source ever gained authority | Binding is required exactly when at least one row is `excluded`; a fully receipted zero-exclusion manifest passes consumer integrity, while the real validate-file enforce fixture remains canonical `full-fallback` and crosses TEST/DONE without deadlock |
| A6-F2 wrapper-root Git cwd | Stored admission rebuilt refs and graphs under metadata root | The consumer receives the already resolved `gitCwd`; config/runtime reads remain under project root while change-manifest, ref and graph reads use the Git tree |
| A6-F3 production graph proof | Tests used handwritten graph literals, leaving unresolved-import hardening unproven at the imported wrapper | The smoke calls the production `core/dual-revision-impact-graph` entry over a real repository with an unresolved relative import and requires `graphUnknown` plus a retained resolution failure |
| A6-F4 evidence wording | Supporting developer checks were described as if all were the single Lab GREEN receipt | The table now distinguishes the pinned tool-owned GREEN from developer-run checks; release notes claim only the replayed command as Lab-owned verification |
| A6-F5 malformed changed paths | Automatic promotion could throw on non-array `changedPaths` | The selector normalizes it to an empty safe input and a re-signed hostile manifest is a boolean refusal without throwing |
| A6-F6 mode-marker conflation | The adapter emitted mode markers without an internal per-mode assertion, while the TEST fixture printed both public markers | The mutation smoke accepts only a registered audit mode and emits a mode-bound internal assertion after its complete suite; the adapter requires it and alone emits the public selector |
| A6-F7 explain projection failure | A catalog projection error escaped the read-only `validation_plan` handler | Projection errors fall back to the compatibility path and append the bounded parse failure to `impact_index_unusable`; the documentation distinguishes explain projection from runtime graph augmentation |

A new repair commit, pinned GREEN and exact post-bump independent audit are still
required. Supporting checks remain non-authoritative until they are rerun on the
new repair head; no failed candidate is described as released.

## Seventh Claude audit and remediation

The Lab-finish audit of candidate `d6b0c374f1` returned `fail` under run
`20144da9-914b-460d-bb21-dcc402cb50a1` after 587,456 ms. Finish stopped before
main integration and the candidate was reopened. The nine reported findings are
addressed as follows:

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A7-F1 vacuous policy-floor tests | Whole-repository and full-only assertions passed only because a missing graph escalated every row | Both fixtures supply a complete no-impact graph and assert `fullEscalated=false` before checking the policy disposition; the full-only fixture supplies an exact signed baseline receipt |
| A7-F2 stored graph context drift | Admission rebuilt a different scope-free change manifest and could reject a valid PASS | The signed manifest's base/head graph digest is recomputed directly from immutable Git revisions and current catalog, then compared before selector reconstruction; the real gate fixture carries a scope contract across TEST and DONE |
| A7-F3 evidence counts | The table retained obsolete 30/20 counts | Counts now match the pinned output: CHK-004 32 and CHK-005 21 |
| A7-F4 narrow Lab GREEN | The immutable original RED/GREEN command covers build plus planner smoke only | The Lab-owned GREEN remains its exact mandatory RED replay; the repair head additionally runs the runtime, mutation, real TEST/DONE and process-fact checks listed in the evidence table, with literal outputs retained in Lab history/release notes rather than mislabeled as the original GREEN |
| A7-F5 selector reachability | Regex discovery treated JSON, examples, generated imports and aliases as missing edges; whole-catalog risk disabled narrowing | Module discovery now uses the TypeScript AST, excludes runtime artifacts, supports `.mts`/`.cts` and source/dist mapping, and limits missing-edge failure to real authority modules. A real 168-command measurement reports `graphUnknown=false`, zero resolution failures and risk counts 51 local / 50 shared / 2 gate / 65 validation-infra. Authority risk uses participating execute/reuse rows, so any selected non-local row still refuses while unrelated exclusions do not |
| A7-F6 unintended DONE widening | Every stored PASS inherited the complete generic admissibility evaluator and intent-integrity errors were flattened | DONE invokes the added evaluator only for a dynamic claim or existing Story-owned dynamic artifacts; marker stripping cannot downgrade it, legacy full evidence is not widened, and intent-amendment integrity errors are rethrown |
| A7-F7 throwing manifest verifier | Unknown tier keys and hostile arrays could escape as `TypeError` | The verifier validates all tier arrays and selector string arrays inside a fail-closed boolean boundary; an unknown-effective-tier mutation proves no throw and `false` |
| A7-F8 stale verdict guidance | Error text said only canonical evidence was allowed | Guidance now names canonical full or a signed complete dynamic ledger |
| A7-F9 stale dist / missing Bun | Bun mode could import old `dist`; an explicitly missing Bun binary had no useful fallback | TEST-gate modes build canonically before importing the consumer fixture, and any Bun `ENOENT` uses the same built Node task fallback |

The next candidate still requires a fresh committed-head GREEN and independent
Claude decision. No failed candidate is described as released.

## Eighth Claude audit and remediation

The Lab-finish audit of candidate `cd28ba9990` returned `fail` under run
`d0299937-8e0e-4a68-94fc-5ad89f8f3e2c` after 562,596 ms. Finish stopped before
main integration and the candidate was reopened. Its eight findings are
addressed as follows:

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A8-F1 graph amplification | Reverse dependency maps were rebuilt per catalog row and change | Base/head reverse maps are built once, affected commands are cached per revision/path, and catalog augmentation calls the graph exactly once per changed file; a call-count fixture proves two changed files cause two calls even with a doubled catalog |
| A8-F2 participating-risk proof | Production used participating rows, but no two-way gate test proved the boundary | Superseded by A13-F1: the current production helper derives the floor from the complete live catalog, so both excluded and participating gate rows disable low-risk authority and force full fallback |
| A8-F3 selector identity | `commandSetDigest` and `snapshotDigest` could be self-consistent caller claims | Pre-launch and stored consumers independently rebuild the live command inventory digest and the Story base/head/change digest; re-signed forged command-set and snapshot bindings are refused |
| A8-F4 hostile ownership shape | `inputsComplete=true` accepted any defined `inputRoots` value | Complete exclusion authority now requires an array containing only non-empty strings; a schema-bypassing string fixture remains partial |
| A8-F5 host-dependent graph digest | A thrown graph error embedded its host-specific message into signed identity | Failure identity stores the stable error class only; paths and arbitrary host wording cannot change the signed graph digest |
| A8-F6 TSX import loss | All files were parsed as TypeScript, so JSX before an import could hide the edge | Script kind follows the real extension; a real Git fixture proves an import after JSX creates the reverse dependency |
| A8-F7 label-only audit modes | Twenty package scripts changed only a tail marker after the same suite | Compatibility names remain, but each mode now invokes a distinct executable assertion against its corresponding manifest, graph/scope, receipt, oracle, authority, scheduler, or recovery object; TEST-gate modes additionally cross the real TEST/DONE fixture |
| A8-F8 DONE context boundary | DONE constructed a partial `HandlerContext` cast and re-resolved Git cwd | Admissibility helpers accept only their narrow root/store/gitCwd contract, and DONE passes the already resolved Git cwd without a type escape |

Dynamic runner v9 invalidates older runner identities because selector snapshot
and live command-set binding semantics changed. A fresh committed GREEN and a
new post-bump independent audit are still required; this section is remediation
evidence, not a release claim.

## Ninth Claude audit and remediation

The Lab-finish audit of candidate `cfb998f2e2` returned `fail` under run
`0bd484d4-297f-4113-8bdf-95547d8a5d43` after 597,046 ms. Finish again stopped
before main integration. Every finding in the returned array is retained below,
including both low-severity hardening items even though the audit summary called
the total “four unresolved findings” while returning five rows.

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A9-F1 observe artifacts widened DONE | Every Story-scoped observe run writes a revocation ledger, and bare ledger presence routed an ordinary canonical PASS through the new strict dynamic DONE evaluator | Artifact provenance now requires an `enforce-low-risk` selection plus receipts; malformed selection beside receipts remains fail-closed. A real observe-mode validate writes its ledger and canonical PASS, then proves `requiresDynamicValidationAdmission=false` and that DONE emits no `stored-validation-admission` row. The enforce-low-risk positive and marker-stripping negative controls still cross the same real DONE consumer |
| A9-F2 runner-version prose | The normative invalidation paragraph said v8 while source and adjacent text said v9 | The paragraph now consistently names runner v9 |
| A9-F3 repeated whole-repository AST construction | Stored-admission calls could rebuild and parse both revisions repeatedly in one process | Complete dual-revision graphs use a bounded eight-entry process cache only for immutable 40-hex commit pairs, keyed by resolved Git cwd, both commits, and the complete catalog. A repeated production-wrapper call over the same real Git fixture must return the identical cached graph object; moving symbolic refs are deliberately not cached |
| A9-F4 untyped option/context calls | Missing `allowDynamicCoverage` failed late, and an empty `gitCwd` was accepted | Both public boundaries now reject malformed runtime inputs immediately with stable named errors; the compiled `.mjs` fixture calls each invalid shape and asserts those exact refusals |
| A9-F5 standalone exclusion verification | The exported row verifier trusted a self-consistent caller-authored selector decision unless its parent verifier had already recomputed it | The standalone boundary now recomputes `selectAutomaticValidationTier(binding.input)` and verifies the binding digest before any exclusion proof; a forged re-signed decision that previously satisfied the row-only checks is rejected |

Supporting checks on the repair tree pass: canonical build, Story-aware core
smoke, 30 replay mutation classes, the real observe/enforce TEST/DONE suite,
static-edge verification with 326 exceptions and zero pending/nested rows, and
the complete process-fact contract. The final repair still requires commit,
fresh Lab GREEN, and another exact post-bump Claude audit.

## Tenth Claude audit and remediation

The Lab-finish audit of candidate `6c629a88a9` returned `fail` under run
`d0efd603-0717-4512-a00e-1b0b602027fc` after 879,982 ms. Finish stopped before
main integration. Claude confirmed the central selector, graph, digest,
ownership, observe-mode, cache, portable-id and version transactions, then
returned five remaining evidence-boundary findings:

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A10-F1 mode assertions reused prior subjects | Twenty named blocks mostly re-asserted module-scope subjects, and two observe/shadow pairs were byte-identical | Every mode now constructs a new mode-specific manifest, mutation, receipt, oracle comparison, authority decision or schedule inside its own block. Observe and shadow modes use distinct paths, failure ids and oracle calls. Each registered mode is executed after the shared mutation floor and can fail independently on its own newly constructed subject |
| A10-F2 unsigned DONE classification | Strict DONE admission was selected from unsigned output markers and writable runtime hints | `requiresDynamicValidationAdmission` authenticates the Story test evidence first; any invalid signature is routed into the strict evaluator before classification. A negative fixture strips the output marker, changes selection mode to observe and removes receipts, yet DONE still emits the blocking signature refusal. A valid signed legacy full PASS and a valid observe PASS retain their prior contract |
| A10-F3 manifest self-binding | Generic manifest verification recomputed the decision but did not compare its snapshot and changed paths with the manifest's own Story fields | Verification now recomputes the Story/base/head/change snapshot digest and requires every normalized `path`/`oldPath` in `manifest.changedFiles` to appear in selector input. Re-signed snapshot and added-path mutations are both rejected without relying on a later stored consumer |
| A10-F4 ambiguous complete-coverage helper | `assertCompleteInventoryCoverage` accepted positive exclusions implicitly | Exclusions are rejected by default and require the caller to pass `{ allowExcluded: true }`; the mutation suite proves both default refusal and explicit tier-aware opt-in |
| A10-F5 dropped explain projection error | `attachImpactProjectionFailure` only decorated an already-present `impact_index_unusable` row | If that row is absent, the adapter appends a canonical widening reason with the bounded projection failure. The planner smoke removes the pre-existing reason and proves the error remains visible |

This repair requires a new build, all twenty mode entrypoints, real TEST/DONE
admission, static-edge and process-fact checks before the next committed GREEN.
No candidate rejected by this or an earlier audit is a release.

## Eleventh Claude audit and remediation

The Lab-finish audit of candidate `971bada371` returned `fail` under run
`87b03032-e696-4f1d-b403-8c5fd7dd2d5f` after 622,747 ms. Finish stopped before
main integration. Claude confirmed the three independent selector-binding
reconstructions, current command/snapshot/change bindings, unconditional
exclusion-proof admission, portable identity, auth-first DONE handling, bounded
graph construction, version transaction and compatibility behavior. Four
remaining boundary and evidence defects were retained and repaired:

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A11-F1 empty complete ownership | `inputsComplete=true` plus `inputRoots=[]` passed `every`, and config could filter non-string-only roots into the same empty array | Configuration rejects empty post-filter ownership, catalog validation names complete coverage with zero roots, compilation requires at least one non-empty declared root, and both empty and non-string-only mutation subjects widen with `command_exclusion_unproven` and no positive exclusion proof |
| A11-F2 real Story metadata path | The production TEST/DONE fixture changed only one material source path, leaving Story-metadata behavior inferred | The same commit now changes the material input and `.proof-or-stop/story/actives/<id>/index.json`; the real resolver still reaches enforce authority, executes only `build`, excludes exactly one unrelated command, and does not report `selector_context_mismatch` |
| A11-F3 structured degradation | A selector refusal retained the canonical oracle but exposed its reason only through an ephemeral log line | Both validate entrypoints attach a stable structured `selector_context_mismatch` or `dynamic_preparation_unavailable` reason and bounded report to `dynamicValidation`; a focused smoke pins the selector mismatch projection |
| A11-F4 standalone proof admission | The named missing-proof test failed earlier at decision recomputation, and the standalone verifier relied on its parent for Story snapshot/path binding | The isolated test keeps the canonical decision, forges only a narrower manifest tier and excluded row, and reaches the missing-proof predicate. The standalone verifier now recomputes manifest Story/base/head/change identity and checks every changed/old path against selector input; a rewritten Story id is refused |

The canonical build, Story-aware core smoke, 30-class mutation audit and real
TEST/DONE fixture passed on the repair tree, including the material-plus-metadata
2-to-1 selection case. A committed-head GREEN and a fresh exact-candidate Claude
PASS remain mandatory before integration.

## Twelfth Claude audit and remediation

The exact repair-head audit of `ca64a0fa50` returned `fail` under run
`68ceeac3-a5a9-4bd3-a0e6-eb2cba50ab54` after 620,112 ms. Claude confirmed the
selector reconstruction, exclusion proof, graph, ownership, DONE authentication,
mode rollout and compatibility boundaries, then retained five consistency and
evidence findings:

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A12-F1 selector-side repository-full reuse | Selector widening selected the complete universe but rows with admissible receipts could still become `reuse`, contradicting the documented conservative oracle | `effectiveTier=repository-full` now makes every catalog row `execute`, even when a matching receipt exists. A focused fixture first proves those receipts reusable, then forces only selector-side full, asserts `fullEscalated=false`, `reused=0`, and every row executed |
| A12-F2 audit selector overclaim | Four audit markers named scope, telemetry, recovery/rollback or shadow-specific guarantees that their assertion blocks did not establish | Public markers now name the exact exercised properties: generated-output full escalation, unrelated-receipt revocation isolation, valid two-command scheduling, and oracle equivalence/discrepancy replay. No marker claims a broader mechanism than its subject |
| A12-F3 free-text selector error classification | Two selector refusal messages missed the regex and appeared as generic preparation failures | All six pre-launch selector context refusals use `ValidationSelectorContextError` with stable code `selector_context_mismatch`; projection tests cover every message plus a non-selector control |
| A12-F4 admission context collision | An optional structural field named `gitCwd` could later collide with a broad `HandlerContext` field | The override is renamed `resolvedStoryGitCwd`, is compared to the authoritative Story workspace, and a wrong-workspace fixture is refused. Broad contexts continue through the canonical resolver |
| A12-F5 static dependency closure | The registered validation-tier planner exception bound two new handler dependencies but omitted its new core Story-aware validation import | The same exception now binds the current SHA-256 of `core/story-aware-validation.ts` alongside the current handler digests; the live static scan reports 326 reviewed exceptions, zero pending review, and zero nested expansion |

After repair, the canonical build, core smoke, 30-class mutation audit, real
material-plus-metadata TEST/DONE admission fixture and live static-edge scan pass.
A new committed-head GREEN and a fresh Claude PASS remain mandatory.

## Thirteenth Claude audit and remediation

The exact repair-head audit of `050c6a9359` returned `fail` under run
`c897a03b-580f-4555-8e68-5d0a17f346d3` after 582,016 ms. Claude confirmed the
three selector reconstructions, proof binding, fail-closed hostile input handling,
repository-full no-reuse rule, auth-first DONE classification, graph cache and
static dependency digests, then found one high-risk participation-floor
asymmetry and four adjacent contract gaps:

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A13-F1 gate rows could disappear | Gate and validation-infrastructure rows projected to repository-full membership, but the executor could positively exclude an unaffected row and the risk calculation then ignored excluded rows | A shared participation predicate now makes `always`, `full-only`, whole-repository, never-reuse, gate and validation-infrastructure rows non-omittable. Authority risk is derived from the complete live catalog. Tests prove an otherwise-unselected gate row executes and an excluded gate mutation forces full fallback |
| A13-F2 consumer did not re-derive floors | Stored TEST/DONE admission validated selector proofs but skipped catalog policy after seeing `excluded` | The stored consumer runs `validationManifestExcludedRowFloorReasons` over the live catalog before receipts; a mutation independently asserts `dynamic_excluded_row_not_omittable` for an excluded gate row |
| A13-F3 observe/shadow shared reuse drift | A helper silently enabled cross-invocation shared execution for observe/shadow by default while prose called it retained behavior | Only `off` enables the previous default. Observe, shadow and enforce require explicit `validate.sharedExecution=true`; planner cases pin all mode/opt-in combinations and the operations guide states this boundary directly |
| A13-F4 mixed invalid complete roots | Complete roots rejected empty/all-invalid arrays but filtered a mixed invalid array into an authoritative valid subset | Complete declarations are accepted only when the original array is non-empty and every original element is a non-empty string. The mixed string-plus-number case is rejected by config, remains partial through schema-bypassing injection, widens with `command_exclusion_unproven`, and yields no proof |
| A13-F5 DONE used two Git trees | Classification used the supplied resolved Git tree, then admission silently resolved another | DONE passes the same tree through `resolvedStoryGitCwd`; the admission boundary compares it with canonical Story resolution. The real fixture derives that tree through the production resolver and a wrong-tree DONE call emits the named refusal |

The canonical build, core smoke, 30-class mutation audit and real TEST/DONE
fixture pass on the repair tree. Static digests were refreshed for the changed
core, handler and planner-smoke dependency closure; committed-head GREEN and a
fresh Claude PASS remain mandatory.

## Fourteenth Claude audit and remediation

The exact repair-head audit of `bfd6af6afd` returned `fail` under run
`80d9ee67-c82e-461a-ad1d-9319ab39eafb` after 784,335 ms. Claude found no
remaining selector/executor/consumer safety bypass. It retained four contract,
naming, test-strength and historical-documentation inconsistencies:

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A14-F1 L4 risk rationale drift | Runtime used the complete live catalog, while the L4 rationale still described execute/reuse participation | The rationale now states the complete-catalog floor and `verify-process-fact-contract.mjs` mechanically pins that sentence |
| A14-F2 misleading risk helper | `participatingValidationRiskTier(catalog, _manifest)` ignored its manifest parameter and inherited an unrelated gate-provider comment | It is renamed `catalogValidationRiskFloor(catalog)`; its comment describes the catalog floor and the DYN-3 comment now sits on the actual prerequisite provider |
| A14-F3 vacuous audit modes | Missing graphs made scope and dual-graph checks full-escalate, while selection checked a row-count identity | Complete graphs now prove a source control does not escalate, generated output escalates for its exact reason, deletion and rename select distinct reverse dependencies including `oldPath`, and selection pins the honest two-row `reuse`/`excluded` partition with exact totals |
| A14-F4 historical prose conflicts | Current docs and two old audit rows still stated superseded risk and caller behavior | Current operations prose uses the complete catalog; A8-F2 explicitly points to A13-F1, and A2-F4 records that every current production consumer explicitly opts in |

The focused audit modes and process-fact contract pass on the repair tree. A
committed-head GREEN and fresh Claude PASS remain mandatory before Lab finish.

## Fifteenth Claude audit and remediation

The exact repair-head audit of `7585e8b996` returned `fail` under run
`388dc899-e300-43d4-a2b1-cb0539697223` after 675,262 ms. Claude again confirmed
that no unproven command can be omitted from a manifest accepted by TEST or
DONE, then retained four explain/execute, compatibility, cache and ownership
defects:

| Finding | Before | Repair / executable evidence |
| --- | --- | --- |
| A15-F1 never-reuse explain/execute drift | Planner could issue an omission proof for an unaffected `never-reuse` row while the executor forced it to execute | Planner and executor now import one `validationCatalogEntryRequiresParticipation` predicate. Every non-omittable row occupies all three selector tiers, is reported included and can never receive an exclusion proof; planner and runtime smokes pin the shared behavior |
| A15-F2 legacy full DONE widening | Any invalid PASS signature entered the dynamic-only DONE evaluator, including unrelated legacy full evidence | Authentication still occurs before classification, but strict dynamic admission now requires a dynamic output claim or authoritative dynamic artifact lineage. An isolated canonical-full fixture proves signed and unsigned legacy records produce the same test-evidence DONE row and neither gains `stored-validation-admission`; marker-stripped evidence with retained enforce lineage still refuses |
| A15-F3 unbounded graph source cache | The eight-entry dual graph cache retained source trees in an unbounded raw-ref cache | Full source trees are cached only for immutable 40-hex revisions and evicted at sixteen entries. A real 18-commit fixture exceeds both bounds and a moved symbolic ref produces a different graph digest |
| A15-F4 declared roots dropped runner paths | Explicit roots replaced runner/case paths, while empty roots became an invalid runtime closure | Selector roots remain declaration-driven, while runtime closure and direct triggers use the union with runner/case-registry paths. Empty non-authoritative roots fall back to heuristics; source types and focused fixtures document and prove both surfaces |

The existing rename-aware relevance-input fixture already proves that both old
and new paths enter the production selector input. Build, planner, runtime and
real TEST/DONE checks must pass again before the next committed GREEN.

## Rollback

Set `validate.dynamic.mode` to `off`, or pass `--dynamicMode=off`. The selector,
manifests, receipts, and diagnostics remain readable, but routine validation
returns to complete-plan execution. Static `--focus=fast` compatibility and
independent DONE-required evidence are unchanged.
