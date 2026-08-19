# Plan — B-04bb: Wire reviewer-scan-budget-guard smoke into lattice validate commands

## Context

Story B-cee5 shipped packages/main/src/tasks/reviewer-scan-budget-guard-smoke.ts, a static guard that fails when reviewer prompt templates regress to unconditional full decisions-directory scans. B-cee5's execution boundary did not allow editing lattice.config.json, so the guard is not wired into validate.commands and never runs during lattice validate.

Current facts (verified 2026-07-09):
- B-cee5 is in TEST on branch story/B-cee5; its guard source and dist output exist only on that branch, not on main.
- Standalone run in the B-cee5 worktree: "reviewer-scan-budget-guard: PASS (6 prompt copies clean, 4 required phrases present)", exit 0.
- lattice.config.json validate.commands line 27 holds the copy-target pattern: the bare-string entry "node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js".
- Hard dependency: B-cee5 must reach DONE and merge to main before this story's validate run can pass; recorded via depends=[B-cee5].

## Approach

One-line config change following the existing per-guard convention: add a bare-string entry to validate.commands, placed immediately after the retired-authority-vocabulary-guard-smoke.js entry. The run-all-smokes aggregate alternative is rejected because run-all-smokes.js is itself not part of validate.commands, so it enforces nothing today, and switching validate to an aggregate runner would change execution semantics for all smokes (out of scope for a small follow-up).

Sequencing: DEV waits until B-cee5 lands on main; then merge main into story/B-04bb, make the edit, build, and run full validate.

## CHK-001 — Add reviewer-scan-budget-guard-smoke entry to validate.commands in lattice.config.json

- Precondition: B-cee5 merged to main; main merged into story/B-04bb so packages/main/src/tasks/reviewer-scan-budget-guard-smoke.ts exists and builds into packages/main/dist/tasks/reviewer-scan-budget-guard-smoke.js.
- Edit lattice.config.json: insert the bare-string entry "node packages/main/dist/tasks/reviewer-scan-budget-guard-smoke.js" immediately after the retired-authority-vocabulary-guard-smoke.js entry in validate.commands.
- Bare-string form (no timeoutMs/focus wrapper) is correct: the guard is a fast static scan, same class as the retired-authority guard which uses the bare-string form.
- Syntax check after edit: node -e "JSON.parse(require('fs').readFileSync('lattice.config.json','utf8'))".
- userSees: lattice.config.json validate.commands contains the new entry; git diff vs main shows exactly one added config line (plus story metadata).

## CHK-002 — Run lattice validate and confirm the new guard command executes and passes

- Run full lattice validate (not focused) in the story worktree.
- Confirm the validate output lists node packages/main/dist/tasks/reviewer-scan-budget-guard-smoke.js as an executed command with PASS, and validate exits 0 overall.
- Negative control (already observed): on current main the guard is absent from validate.commands, so validate never runs it.
- Evidence: verification_evidence_add bound to the literal command "lattice validate" per the evidence-binding convention.

## Risks / preMortem

1. B-cee5 is reworked or never merges: the new entry would reference a missing dist file and break validate on main. Mitigation: hard dependency depends=[B-cee5]; this story does not pass DEV verification or merge until B-cee5 is DONE on main.
2. Path typo in the entry: validate fails at the new command. Mitigation: copy the exact dist path already verified by a standalone run in the B-cee5 worktree; full validate before REVIEW.
3. Worktree rebuild produces dist churn beyond the one config line. Mitigation: execution boundary allows packages/main/dist/ only for standard build artifacts of already-merged sources; check git diff stays limited to lattice.config.json plus story metadata.
4. JSON syntax error (for example a trailing comma) breaks config parsing for every lattice command. Mitigation: JSON.parse syntax check immediately after the edit, before running validate.

## Non-goals

No changes to the guard source, run-all-smokes, other validate.commands entries, lifecycle gates, or DONE semantics.
