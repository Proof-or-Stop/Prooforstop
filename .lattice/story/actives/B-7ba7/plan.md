# B-7ba7 Plan — Read-only milestone status reporting

## Scope

Build `lattice milestone_status --storyId=B-xxxx` as a read-only report over existing ProofStory milestone ledger, checklist, verificationIntent, verificationEvidence, and summary facts. V1 prints completed/current/remaining groups and expands the current milestone with sub-objective detail. It does not write milestone completion state, run commands, launch reviewers, advance lifecycle phase, or claim production/Authority completion.

## CHK-001 Define the milestone status report contract and data model

**Owner**: main-agent

**Plan**:
- Add `packages/main/src/core/milestone-status.ts` with a pure report model.
- Read the story phase, milestone ledger, checklist items, verificationIntent, verificationEvidence, and optional summary.
- Derive milestone rows from the existing ledger only; do not create another milestone store.
- Derive sub-objectives from `checklistRefs`, `verificationIntentRefs`, and `requiredEvidence` hints. If future completion-writer artifacts are absent, report transition detail as unavailable rather than inventing it.
- Classify groups as `completed`, `current`, and `remaining` using ledger/checklist/evidence facts.

**Verify**:
- Unit test JSON report shape for a sample story with a confirmed ledger.
- Unit test missing-ledger report returns a blocker/next action and does not claim progress.
- Unit test no mutation path by exercising report builder on temporary story data and checking no writer is called.

**Risks**:
- Risk: report rows become a second source of truth.
- Mitigation: report model stores only projection fields and source refs; persistence remains in existing store artifacts.

## CHK-002 Add the read-only milestone_status CLI command

**Owner**: main-agent

**Plan**:
- Add `packages/main/src/handlers/milestone-status.ts` with `milestone_status` handler.
- Wire handler in `packages/main/src/registry.ts`.
- Add command schema in `packages/main/src/cli/command-catalog.ts` using the existing read-only unsupported flags pattern.
- Support `--format=text|json` and `--json`.
- Render text with completed milestones first, current milestone in the middle with expanded sub-objectives, and remaining milestones below.

**Verify**:
- CLI smoke through built dist or handler invocation returns grouped text.
- JSON mode includes `mode.readOnly=true` and `mode.runCommands=false`, `mode.writeEvidence=false`, `mode.advancePhase=false`.
- Passing mutation-like flags is rejected by schema or handler before story facts are consumed.

**Risks**:
- Risk: users infer the command completed a milestone.
- Mitigation: text renderer includes a read-only line and prints next actions instead of performing them.

## CHK-003 Project completion and verification detail into milestone rows

**Owner**: main-agent

**Plan**:
- Map each ledger row to checklist refs and verification intent refs.
- Mark a row completed only when row/checklist/evidence facts support completion. A `done`-like ledger status without evidence produces a warning/next action.
- For partial rows, render the row as current/in_progress and list missing sub-objectives/evidence.
- Include evidence refs from checklist `verificationEvidence` and source refs back to milestone/checklist/intent ids.
- Show risks such as missing ledger, missing checklist ref, missing verification intent, or missing evidence.

**Verify**:
- Test completed row with passing evidence.
- Test partial row with one missing evidence ref.
- Test adversarial row where checklist says done but evidence is absent; report must not silently present it as complete.

**Risks**:
- Risk: stale evidence classification duplicates lifecycle readiness rules.
- Mitigation: V1 reports evidence presence and source refs; it does not override validate/lifecycle_check freshness decisions.

## CHK-004 Document and test the grouped progress reporting workflow

**Owner**: main-agent

**Plan**:
- Add focused tests for report builder, renderer, missing ledger, grouped output, and no-mutation behavior.
- Update `docs/CLI.md` with command usage and Host Progress Reporting Contract.
- Documentation must state that full detail requires granular milestone ledger rows and that richer transition history waits for future completion-writer/executor-ledger integration.
- Documentation must not claim automatic execution, automatic DONE, Authority completion, or production readiness.

**Verify**:
- Run focused test file.
- Run TypeScript build if dependencies are available; otherwise report dependency blocker explicitly.
- Run `lattice milestone_status --help`/CLI smoke after build or via local source handler test.

**Risks**:
- Risk: documentation overclaims that V1 shows details that are not present in the ledger.
- Mitigation: docs distinguish projected detail from unavailable transition fields and state prerequisites clearly.

## Host Progress Reporting Contract

After every material milestone or sub-objective status change, at handoff, and in the final response, the host should print the full milestone table grouped as:

1. Completed milestones at the top.
2. Current milestone in the middle, expanded with sub-objectives, evidence, risks, and next action.
3. Remaining milestones below.

The table is a visibility surface. Lifecycle authority remains with existing Story, validation, review, and DONE gates.
