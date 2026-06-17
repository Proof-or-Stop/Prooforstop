# B-8387 Execution Plan — Experience Layer Phase 2 (Process Playbook lifecycle)

Staged playbook lifecycle: distil a resolved finding into a human-approved
candidate playbook. Never auto-files findings or touches gates; lineage mandatory;
digest fail-closed (clone decision-doc via core/digest.js leaf).

## CHK-001 Types + learning-store for playbooks.json + proposals/
experience-layer-types.ts: PlaybookProposal {id,title,trigger{keywords,fileKinds,
storyPhases},check,pitfalls[],verification[],lineage{sourceStoryId,sourceFindingId,
sourceSignature},status:'proposed',proposalDigest}; Playbook {same core +
status:'proposed'|'candidate'|'active'|'stale'|'archived', usage{surfacedCount,
resolvedHits,dismissedHits}}. learning-store.ts: atomic read/write of
.lattice/learning/playbooks.json + proposals/<id>.json. computeProposalDigest uses
digestCanonicalJson from core/digest.js over the proposal domain (excluding the
digest field). Zero outward imports except core/digest.js.
Verification: smoke round-trips proposal + playbook; proposalDigest stable.

## CHK-002 playbook_propose + playbook_diff + playbook_reject
handlers/playbook.ts: playbook_propose --finding <id> reads the finding via the
finding subsystem (+ signatureTag), builds a staged proposal with lineage +
proposalDigest, writes proposals/<id>.json. playbook_diff <proposalId> renders
read-only what approve would write. playbook_reject <proposalId> discards it.
Never calls finding_add or any gate.
Verification: smoke exercises propose (lineage+digest), diff (no mutation), reject.

## CHK-003 playbook_approve (digest fail-closed) -> candidate + CLI registration
playbook_approve <proposalId> --expectedProposalDigest: must match the stored
proposalDigest (stale fails closed). On match, writes a candidate Playbook
(status=candidate, lineage carried) to playbooks.json and clears the proposal.
active is NOT auto-set. Register the 4 commands (flat underscore) via
command-policy.ts/config.ts/registry.ts/cli-engine.ts.
Verification: smoke asserts stale-digest rejection; matching-digest -> candidate
with lineage; status=candidate (not active); no finding auto-created.

## CHK-004 Smoke + npm script + no regression
tasks/experience-layer-playbook-smoke.ts + package.json test:experience-layer-playbook.
Hermetic. Assert: full propose->diff->approve->reject lifecycle; digest fail-closed;
lineage on candidate; never-auto-finding/gate guardrail; learning modules zero
outward coupling (except core/digest.js + finding read port); build clean; existing
experience-layer + decision-doc smokes still pass.
Verification: npm script exits 0 'smoke passed'; verifier TOTAL N | PASS N | FAIL 0.

## Out of scope
Auto-promotion to active; surfacing playbooks into reviewer prompts; cross-project
sharing; any finding_add/gate side effect.
