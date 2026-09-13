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
| A3-F1 selector context binding | A self-consistent caller binding could describe a different catalog or omit a changed path | The binding now includes the executor catalog digest; prepare and stored-evidence admission rebuild the current catalog/index, compare the exact command universe, and require actual changed and old paths to be covered |
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
| A4-F11 mutation precision | Two full-manifest mutations failed first at generic decision recomputation | The positive-proof row invariant is now an independently callable verifier; isolated tests exercise inside-effective-tier and missing-proof refusals, while full manifest mutations retain end-to-end coverage |
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
| A5-F8 malformed selector input | Hostile non-array impact entries could make a boolean verifier throw | Array guards force the planner's safe fallback and authority evaluation converts verifier exceptions to `selection-manifest-invalid` |
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

## Rollback

Set `validate.dynamic.mode` to `off`, or pass `--dynamicMode=off`. The selector,
manifests, receipts, and diagnostics remain readable, but routine validation
returns to complete-plan execution. Static `--focus=fast` compatibility and
independent DONE-required evidence are unchanged.
