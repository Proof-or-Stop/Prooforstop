# B-6703 Real-Machine Transcript Diff

Story: B-6703 - Evidence-activate candidate playbooks after explicit exposure outcomes
Phase: TEST
Recorded: 2026-07-03

## Expected

- `lattice story_advance ... TEST` should pass REVIEW completeness, CLI gate preflight, and configured validation.
- `lattice validate --story=B-6703 --json` should run the configured project validation command set and return `status: pass`.
- The story-specific smoke should prove the product behavior:
  - DONE experience can become inert candidate material.
  - Candidate activation does not happen from DONE success alone.
  - `playbook_auto_promotion_apply --apply` activates only after explicit candidate exposure and structured non-DONE-settlement helped outcomes.
  - Active playbooks remain advisory, non-authoritative, and runtime-consumed.
  - Duplicate applied promotion decisions are idempotent.

## Actual Transcript

Command:

```sh
lattice story_advance '{"storyId":"B-6703","phase":"TEST","forceTakeover":true}'
```

Result:

- REVIEW completeness: pass.
- CLI gate preflight: all pass.
- DEV->TEST validation: 32 configured validation commands ran.
- Validation result: PASS.
- Story advanced to TEST.
- Duration reported by command: 118.4s.

Command:

```sh
lattice validate --story=B-6703 --json
```

Result:

- Provider: `lattice-verifier-configured-commands`.
- Status: `pass`.
- allPass: `true`.
- Summary: `Project validation commands passed`.
- Configured commands run: 32/32.
- Duration reported by command: 109.4s.

Story-specific verification already recorded in checklist evidence:

- `npm --prefix packages/main run build`: pass.
- `node packages/main/dist/tasks/playbook-seed-promotion-loop-smoke.js`: pass, 16/16 checks.
- `git diff --check`: pass.

## Diff Notes

- Expected and actual behavior match.
- No user-visible command failed.
- No acceptance gap was observed between the plan and actual machine output.
- The activation loop is evidence-based: candidate playbooks do not become active from DONE success alone, and activation requires explicit candidate exposure plus structured helped outcomes.
- Runtime consumption is verified for active advisory playbooks; candidates remain inert until activated.
- The implementation remains scoped to advisory playbook activation and does not introduce timer-driven promotion, historical backfill, blocking policy, or gate evidence.
