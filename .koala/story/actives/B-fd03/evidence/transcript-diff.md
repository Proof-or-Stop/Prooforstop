# B-fd03 TEST transcript diff

Date: 2026-06-02

## Expected

B-fd03 should make Lattice the primary user-facing CLI name while preserving `koala` as a legacy alias. The rollout checker should:

- expose `lattice rollout_check` and `lattice rollout check`;
- return schema `lattice.rollout_check.v1`;
- report `readOnly=true` and `macAppRequired=false`;
- return per-project `status` and `nextAction`;
- avoid write-capable repair paths such as `--apply`, `--upgrade`, `--repair`, and `--fix`;
- keep authority/receipt behavior unchanged.

The docs and prompts should prefer `lattice ...` for normal user actions and mention `koala` only as a compatibility alias or historical/package identifier.

## Actual

Verification commands run in the story worktree:

```bash
koala validate --story=B-fd03 --json
npm run test:rollout-check-smoke
node packages/main/dist/tasks/session-brief-prompt-sync-smoke.js
```

Results:

- `koala validate --story=B-fd03 --json`: PASS; explicit intent coverage `12/12`, warnings `[]`.
- `npm run test:rollout-check-smoke`: PASS.
- `node packages/main/dist/tasks/session-brief-prompt-sync-smoke.js`: PASS.

The real-project transcript is recorded in `rollout-transcript.md`. It reports a conservative diagnostic result for the local fleet: `total=6`, `pass=0`, `warn=3`, `fail=3`, with each project carrying a `nextAction`.

## Diff

- Expected primary CLI naming: met. User-facing prompts, session hints, README, guide, and project vision now prefer `lattice`.
- Expected legacy compatibility: met. Docs explicitly verify both `lattice --version` and `koala --version`; `koala` remains a legacy alias, not the preferred command.
- Expected read-only rollout scanner: met. Smoke tests assert no apply/upgrade/repair/fix commands and unchanged git status for scans.
- Expected per-project diagnostics: met. Transcript records actual warn/fail status rather than forcing a fixed pass distribution.
- Authority boundary: unchanged. `rollout_check` is L0/read-only and does not submit evidence, verify receipts, or provision model runners.

No user-visible mismatch remains after F-009: CHK-004 now promises the actual conservative `status`/`nextAction` diagnostic contract instead of hard-coded project statuses.
