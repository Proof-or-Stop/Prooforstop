# B-6241 Real-Machine Transcript Diff

## Expected outcome

B-6241 should complete the V1 playbook promotion worker loop described in
`docs/requirements/decisions/playbook-promotion-worker-execution-plan.md`:
candidate playbooks can be assessed, activation can be recommended without
auto-activating candidates, non-activation transitions can be recorded, DONE can
settle only explicit learning exposures, and candidate inspection remains
separate from active runtime guidance.

## Actual transcript

Commands run from `/Users/jek/Documents/Work/proofbound/.worktrees/B-6241`:

```text
npm --prefix packages/main run build
node packages/main/dist/tasks/playbook-promotion-worker-smoke.js
node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js
lattice validate --story=B-6241 --json
lattice done_required_validate --storyId=B-6241 --json
lattice quorum_submit --storyId=B-6241 --hostA=claude-code-cli --hostB=codex-cli --providerA=claude --providerB=codex --rounds=3 --format=json
```

Observed results:

```text
npm --prefix packages/main run build
PASS

node packages/main/dist/tasks/playbook-promotion-worker-smoke.js
PASS

node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js
PASS

lattice validate --story=B-6241 --json
PASS; verification coverage 30/30 covered.

lattice done_required_validate --storyId=B-6241 --json
PASS; packages/main build and root full test suite passed.

lattice quorum_submit ...
PASS; emitted 6 verdicts across 3 rounds with 2 independent host ids per round.
```

## Expected vs actual diff

No behavioral gap observed. The implementation delivered the expected V1
boundary: promotion sweep records recommendations and non-activation state
transitions, candidate playbooks stay out of active runtime guidance, DONE
settlement does not infer `helped` from DONE success alone, and non-deducible
source signatures block repeat proposals unless explicitly overridden.

## Notes

The first REVIEW to TEST attempt exposed a real vocabulary-guard issue in two
new command-policy reason strings. That wording was fixed and revalidated before
the final TEST evidence was recorded.
