# B-fbcf Plan

## Conflict Audit

Before implementation, B-fbcf was checked against the active sibling stories named in the execution plan. B-eb08 already has a story/B-eb08 branch that changes packages/main/src/handlers/done-prepare.ts, packages/main/src/cli/command-catalog.ts, packages/main/package.json, and adds done-prepare-closure-heartbeat-smoke.ts. Its ownership is closure heartbeat/progress labels, independent phase deadlines, JSON liveness, and the done_prepare json flag.

B-eb92 is still INIT and owns review-assurance surfacing, canonical reason/fallback/legal-writer guidance, and cannot-auto-sign blocker guidance. B-b264 is still INIT and owns merge/rerun hazard guidance, generated-file ownership reporting, and dryRun immutability. B-fbcf must consume those surfaces and must not duplicate their user-facing wording or gate semantics.

Development rule: do not start B-fbcf code edits against stale main if B-eb08 is not merged. Either wait for B-eb08 to land on main, or explicitly integrate its branch before DEV implementation. B-eb92/B-b264 remain semantic no-overlap boundaries until they merge.

## Audit Summary

The user-provided execution plan is coherent and safety-oriented, but the source document currently lives only under the retired Orchestrate path. B-fbcf will first materialize that plan into the canonical Proofbound docs path so relatedDocs are real.

The chosen implementation is narrow: explicit opt-in flags, current-run generated lifecycle metadata only, strict validation reuse bindings, a single post-commit done_prepare re-evaluation, and no DONE advancement or authority-sensitive evidence writes.

## CHK-001 - Lock no-overlap scope and generated metadata manifest

Create the canonical Proofbound decision doc from the legacy source. Add a small core helper for current-run generated metadata records. The helper should model path, before hash, after hash, producer phase, reason, command-backed status, and safe-to-auto-stage classification. It must use existing lifecycle artifact scope/classifier semantics and configured storyDir handling instead of hard-coded story paths.

Verification focus: current-run generated done-required/test evidence is recorded; pre-existing dirty lifecycle files are not current-run generated; no new B-eb08/B-eb92/B-b264 owner text appears.

## CHK-002 - Add opt-in safe auto-commit for manifest-only lifecycle metadata

Add explicit done_prepare options, expected to be autoCloseGeneratedMetadata and reuseFreshValidation, and document them in the command catalog after reconciling with B-eb08 json support. Before staging, re-read status and refuse unrelated modified, staged, untracked, deleted, renamed, runtime, source, docs, or unsafe paths unless they are exactly current-run manifest files. Stage exact manifest paths only and commit with a deterministic message such as lattice: auto-close <storyId> generated DONE metadata. Do not bypass hooks.

Verification focus: success commits only manifest paths; refusal happens before mutation for unrelated dirt; no broad git add/stash/checkout/reset/clean/push/publish/release command path exists.

## CHK-003 - Reuse validation only for proven metadata-only HEAD drift

Add validation reuse logic that compares prior PASS evidence with the new HEAD after the safe metadata commit. Required matches include materialHash, storyFilesHash, validation commandSetHash, DONE-required commandSetHash, scope contract hash, lifecycle classifier version, validation config hash, DONE-required config hash, and relevant gate policy/config hash. Preserve prior transcripts and write an explicit metadata-only reuse record.

Verification focus: metadata-only drift does not execute full validate commands; material/story/config/policy drift refuses reuse; reuse output never claims commands were rerun.

## CHK-004 - Re-evaluate DONE prepare after safe auto-closeout without auto-advancing DONE

After a successful safe commit and reuse decision, re-run doneClosure, runtimeChange, and cleanTree projection from the new HEAD using the post-B-eb08 closeout phase/liveness structure. If generated metadata was the only blocker, return PASS and print the next legal story_advance --phase=DONE command. If real blockers remain, surface canonical blockers from existing done_prepare/B-eb92/B-b264 paths instead of inventing parallel guidance.

Verification focus: the former done_prepare -> commit -> done_prepare fixture reaches PASS in one opt-in command; missing review assurance still blocks; no auto-advance, version bump, push, publish, Authority, or production claim occurs.

## CHK-005 - Add regression coverage for safety and JSON cleanliness

Add a focused smoke task and package script. Cover success, unrelated dirt refusal, material drift, missing review assurance, JSON parseability compatible with B-eb08, no auto-signing, and no remote/publish behavior. Keep the smoke focused so it does not expand unrelated validate surfaces.

Verification focus: build plus smoke pass; JSON mode stdout parses; authority-sensitive artifacts/events are not written; B-eb08/B-eb92/B-b264 behavior is not duplicated.
