# B-dddd Transcript Diff

## Expected

The user-visible story outcome is that the playbook outcome ledger rejects
implicit positive learning and keeps the command host-neutral:

- DONE/story completion alone is not recorded as a helped playbook outcome.
- A helped outcome requires concrete exposure and a structured verdict source.
- `playbook_outcome_record` is a plain Lattice workflow command, not a
  Codex-specific or Claude-specific namespace command.

## Actual

Captured on this worktree with `lattice live_smoke_transcript --write`:

```bash
bash -lc "npm --prefix packages/main run test:experience-layer-playbook > /tmp/bdddd-playbook-smoke.log 2>&1 || true; grep -E \"outcome: (ordinary story/DONE completion alone is not recorded as helped|helped requires concrete exposure and structured verdict source|no Codex/Claude-specific namespace introduced|playbook_outcome_record explicitly appends)\" /tmp/bdddd-playbook-smoke.log; grep -q \"decision-doc-promotion-smoke.js:346\" /tmp/bdddd-playbook-smoke.log && echo baseline_failure_confirmed=decision-doc-promotion-smoke.js:346; exit 0"
```

Observed output:

```text
check: outcome: playbook_outcome_record explicitly appends a non-authoritative ledger row -- PASS
check: outcome: ordinary story/DONE completion alone is not recorded as helped -- PASS
check: outcome: helped requires concrete exposure and structured verdict source -- PASS
check: outcome: no Codex/Claude-specific namespace introduced -- PASS
baseline_failure_confirmed=decision-doc-promotion-smoke.js:346
```

The baseline failure marker is intentionally reported: the full
`test:experience-layer-playbook` task still contains a pre-existing
`decision-doc-promotion-smoke.js:346` failure on canonical `main`. The focused
B-dddd outcome checks pass before that baseline failure and were also reviewed
by the test-coverage reviewer.

## Diff Verdict

Expected and actual match for this story's user-visible outcome. There is no
implicit DONE-to-helped settlement, no missing exposure acceptance, and no
host-specific outcome-recording namespace.

