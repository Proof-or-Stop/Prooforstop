# B-576e Execution Plan

Goal: retire Authority Server as an active Proofbound CLI/runtime concept while preserving the local evidence system that replaces it: proof-admissibility, local review/quorum assurance, and offline receipt-bundle anti-tamper checks.

Non-goals: do not delete local proof-admissibility, local quorum/review evidence, or offline receipt-bundle behavior. Do not edit story metadata or fixtures directly.

## CHK-001 Freeze replacement vocabulary for Authority Server retirement

Plan:
1. Update source-of-truth evidence docs to name the active vocabulary: admissibilityStatus, assuranceLevel, evidenceScope, local gate-consumed evidence, local signed/offline bundle evidence, and local review quorum.
2. Mark Authority Server production receipts and Authority production completion fields as retired/out-of-core rather than future local CLI goals.
3. Keep legacy references only when clearly marked as historical/retired.
4. Mark every authority-specific decision-source document in this story as retired/legacy reference or superseded by local proof admissibility; no active external-adapter/future Authority Server implementation baseline remains.

Verification:
- Scan docs for active Authority Server guidance and productionDone/fullAuthorityDone/authorityDone local-state claims.
- Confirm replacement vocabulary is present.
- Confirm authority-specific decision docs are not presented as active implementation baselines.

Rollback:
- Revert only doc vocabulary changes if the implementation proves too broad; do not re-enable server command surface without a new decision.

## CHK-002 Clean user-facing docs and host prompts

Plan:
1. Replace active prompt blocks that say local evidence is non-authority unless an Authority Server receipt exists.
2. Update packages/main/templates/agents first, then generated .lattice-codex and .claude copies.
3. Clean README/docs/guide user-facing Authority Server mode sections into local admissibility guidance or retired legacy notes.

Verification:
- Guard scans templates and generated prompt copies.
- Manual spot-check confirms agents are told what local evidence means, not what Authority Server would have meant.

Rollback:
- If regenerated prompts drift, re-run template sync after correcting the template source.

## CHK-003 Remove server-backed Authority command surface

Plan:
1. Remove server-backed authority_* command catalog entries and alias-normalizer routes.
2. Remove command-policy/process-fact/config/registry registrations for authority_status, authority_enforce_policy, authority_receipt_verify, authority_enforce_runner, authority_receipt_fetch, authority_verdict_submit, authority_job_create, authority_verdict_list, and authority_job_status.
3. Preserve local proof/admissibility/quorum commands.

Verification:
- lattice help and the retired-term smoke do not show retired server-backed commands.
- Local proof-admissibility/quorum commands remain registered.

Rollback:
- If a local command unexpectedly depended on a removed registration, restore the local command only under local admissibility naming; do not restore server-backed Authority aliases.

## CHK-004 Delete or quarantine server-backed Authority implementation paths

Plan:
1. Remove active imports/handlers for server-backed Authority control plane, job loop, receipt fetch/verify, and server verdict paths.
2. Delete or quarantine obsolete server-only tasks from package scripts/config.
3. Keep local receipt-bundle, proof-admissibility, quorum_submit, review escalation, and local assurance tests passing.

Verification:
- npm build catches stale imports.
- proof-admissibility and receipt-bundle smokes pass.
- Guard confirms no active LATTICE_AUTHORITY_URL/mode/server receipt path remains.

Rollback:
- If a helper is shared with local evidence, move/rename the helper into a local module rather than restoring server Authority semantics.

## CHK-005 Add regression guard for retired Authority Server semantics

Plan:
1. Add retired-authority-server-semantics smoke.
2. Scan command catalog, aliases, config/policy/registry, docs, prompt templates, and generated prompt copies.
3. Permit explicit retirement/legacy notes only through a narrow allowlist.

Verification:
- The smoke passes on the cleaned tree.
- A targeted local negative fixture in the smoke proves a retired active command/string would be rejected.

Rollback:
- If the allowlist is too strict, narrow the scan target or annotate legacy docs; do not remove the guard.

## CHK-006 Validate, bump version, and finish story

Plan:
1. Run npm --prefix packages/main run build.
2. Run retired Authority Server guard, proof-admissibility smoke, receipt-bundle contract smoke, and any affected local assurance smokes.
3. Run lattice validate for B-576e.
4. Bump CLI patch version because command/runtime behavior changes.
5. Advance review/test/done through Lattice gates.

Verification:
- Build and targeted smokes pass.
- lattice validate passes.
- lattice --version reports the bumped patch version after rebuild.

Rollback:
- If validation fails due to unrelated dirty baseline files, isolate B-576e evidence in the story worktree and report unrelated root dirt separately.
