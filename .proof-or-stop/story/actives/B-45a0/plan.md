# B-45a0 Story-Aware Dynamic Validation Execution Plan

## Objective and user-visible outcome

Implement the complete story-aware dynamic validation program described by the approved execution plan at `docs/requirements/decisions/story-aware-dynamic-validation-execution-plan.md`. A user running the validation command sees a signed, reproducible plan bound to the current source HEAD and base revision, the complete current validation inventory, explicit execute/reuse/unverified accounting, deterministic waves, per-command receipts, and a final PASS only when closure, evidence, cleanup, and authority prerequisites are all satisfied. Any uncertainty fails closed or escalates to a full canonical run.

The implementation is layered as DYN-1 observe, DYN-2 shadow receipts and reuse, DYN-3 low-risk dynamic TEST authority, DYN-4 weighted resource-safe scheduling, and DYN-5 quorum/review-pass sharding. Existing full validation remains the oracle until all authority gates are proven.

## Scope and non-goals

In scope are catalog discovery and identity, current-main inventory freezing, StoryChangeManifest and dual-revision impact graph, closure certificates, deterministic selection, signed manifests and receipts, canonical baseline/revocation handling, observe/shadow/enforce modes, TEST authority gates, scheduler/resource claims, quorum and review-pass sharding, replay/fault-injection/mutation/performance/audit evidence, rollback, and CLI/report integration. Out of scope are unrelated product behavior and any weakening of the existing complete-plan validator. All changes must preserve command order, verdict semantics, resource safety, cleanup, and full-plan fallback.

## CHK-001

Import the approved design record byte-for-byte into `docs/requirements/decisions/story-aware-dynamic-validation-execution-plan.md`, bind its source path, SHA-256, and section inventory in the implementation metadata, and add a verifier that rejects drift, truncation, or a missing source record. The imported document remains the normative source for DYN-1 through DYN-5 and their audit matrix.

## CHK-002

Discover the current `lattice.config.json` validation command list at kickoff, assign stable command IDs, normalize command identity and roots, and persist an inventory digest and implementation boundary. The characterizer must report the exact N, command labels, roots, optional/full-only semantics, resources, CPU weights, expected P50 values, and package ownership. It must distinguish the configured validation inventory from the broader root `npm test` suite and never use a historical count as authority.

## CHK-003

Implement `StoryChangeManifest` with base/head revisions, changed-file status (add/modify/delete/rename), old paths and blob IDs, planned files, pins, affected process facts and capabilities, scope violations, and a change digest. Build a dual base/head impact graph covering static imports, literal dynamic imports, package exports, CLI registry entries, generated bindings, and explicit bindings for nonliteral or child-process inputs; unresolved dynamic input escalates to whole-repository coverage. Provide one shared changed-file resolver consumed by freshness, selection, and authority gates.

## CHK-004

Define the validation catalog schema and verifier. Every catalog entry must have a unique stable ID, canonical command/input closure, roots and globs, process-fact and capability bindings, full-only semantics, resource claims, positive CPU weight, expected P50, cleanup policy, and build dependency. Generate signed closure certificates from dual-HEAD source closure, runtime baseline traces, process-fact/capability bindings, and the command catalog. Reject missing or duplicate IDs, invalid roots/globs, unknown facts/capabilities, malformed resources, bad weights, closure drift, dist-only authority, and incorrect full-only declarations.

## CHK-005

Implement deterministic three-state selection: execute, reuse, and unverified. Selection must account for changed source, graph closure, affected facts/capabilities, full-only commands, canonical baseline trust, pins, revocation, and uncertainty. Enforce inventory = executed + reused + unverified; final unverified and unmapped/uncovered entries are zero; execute and reuse sets are disjoint; singleton-union monotonicity holds; and no heuristic subtraction is used. Any uncertainty executes or escalates to the full plan. Emit a signed manifest digest including HEAD/base, scope, pins, catalog, inventory, graph, toolchain, closure, baseline, revocation, and historical snapshot.

## CHK-006

Deliver DYN-1 observe-only mode. Instrument validation without changing authority, command order, verdicts, resource claims, cleanup, or full-plan behavior. Record observed selection, closure, gaps, and shadow schedule; continue the complete plan as the oracle; compare selected and full failures; and isolate instrumentation side effects. Report gaps and reason codes without allowing observe data to make TEST or DONE pass.

## CHK-007

Deliver DYN-2 source-first per-command receipts and canonical baselines. A receipt binds command ID, command/input closure, catalog and inventory digests, runner and toolchain identity, build proof, source HEAD/base, canonical baseline epoch, clean tree, environment, result (PASS/FAIL/TIMEOUT), output digest, duration, creation and expiry timestamps, producer, signature, and revocation state. Wave 0 build always executes. Reuse lookup is deterministic and accepts only a trusted ancestor/epoch, current clean tree, valid signature, unexpired receipt, matching closure, and non-revoked baseline. Default expiry is no more than 24 hours; revocation is append-only.

## CHK-008

Run shadow reuse against the complete-plan oracle. For every selected/reused run, execute or simulate the full plan as the authority, compare command-level and aggregate verdicts, and record mismatches, false negatives, and unexplained inputs. Prove that warm reuse and fresh execution produce equivalent verdicts, resources, cleanup, output ordering, and failure attribution. Shadow mismatches force full execution and revoke the affected baseline.

## CHK-009

Implement DYN-3 fail-closed low-risk dynamic TEST authority. Only eligible local or documentation Stories can use dynamic evidence. TEST requires the current signed manifest, inventory/catalog/change/closure/build/baseline/revocation facts, zero gaps and unverified entries, valid execute/reuse receipts, executed pins, no ignored escalation, clean tree, and current toolchain. All twelve blocking prerequisites in the source plan are independently checked. Dynamic authority never replaces the independent full-validation and DONE-required policies; failed prerequisites fall back to the complete plan.

## CHK-010

Provide operational controls and honest reports: modes off, observe, shadow, enforce-low-risk; enable/disable/rollback with append-only configuration history; structured reports for selection, receipts, gaps, schedule, reuse, and authority; periodic 24-hour baseline/full audits; historical replay classes; and explicit risk-tier performance reporting. Warm-cache performance is measured separately from cold runs, with no claim that dynamic validation is faster when the selected risk tier is not comparable.

## CHK-011

Add replay, fault-injection, mutation, and enforcement evidence. Cover at least 30–50 historical change classes, FI-1 through FI-5 for each catalog entry, mutation cases for missing/duplicate IDs, closure drift, stale/forged/revoked receipts, deleted or duplicated inventory entries, wrong routing, ignored escalation, resource violations, static PASS, and residue. Run three alternating current-HEAD paired runs. Require zero false negatives, zero undeclared runtime inputs, all mutants rejected, zero residue, and verdict equivalence. Persist machine-readable reports and commands suitable for REVIEW and TEST evidence.

## CHK-012

Implement DYN-4 weighted longest-processing-time scheduling for selected execution. Use positive CPU weights and expected P50 to form stable deterministic waves, enforce worker and CPU capacity, refine resource claims for git common directories, fixed paths, ports, runtime locks, and main-write locks, and honor drain barriers before dependent or full-only work. Emit a schedule timeline with start/end, worker, CPU, resources, and command IDs. Scheduler mutation tests must prove that removing capacity, exclusivity, or drain enforcement cannot yield an authoritative PASS.

## CHK-013

Implement DYN-5 safe quorum and review-pass sharding. Assign stable case IDs, route every case exactly once, support quorum of three or four independent shards and review-pass groups of three, retain a real end-to-end sentinel in every domain, and aggregate the original verdict rather than a static success token. Reject omissions, duplicates, wrong routing, shard failure, resource conflicts, cleanup interruption, missing sentinels, and process/temp/ticket/quarantine residue. Preserve exact case attribution and replayable aggregate receipts.

## Cross-cutting verification and delivery

All new logic must be covered by focused unit/integration/CLI tests plus mutation tests. Add CLI entry points and reports without breaking existing validation. Update process-fact/runtime registries for every gate-consumed fact and run their contract verifiers. Run the package build, the configured validation suite, and the broader root `npm test` suite before DONE. Record verification evidence against each checklist intent with current HEAD and material hash. Review and TEST must consume signed, current artifacts only.
