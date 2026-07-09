# B-d8ef Real-Machine Transcript Diff

Story: B-d8ef - Probe canonical host execution readiness and observable launchers
Phase observed: TEST
Observed at: 2026-07-09T16:01:23Z

## Expected

- Review host readiness must be based on executable noninteractive launcher readiness, not only binary/version presence.
- Claude reviewer launchers must use `claude --print --verbose --output-format=stream-json <prompt-file>`.
- Legacy/version-only host probes must not satisfy non-human degraded fallback proof.
- Review fallback diagnostics must use `reviewReadyHostCount` and block single-host fallback when two canonical hosts are review-ready.
- New v2 host probes may omit retired completion markers, while forged non-false marker values, wrong event types, and wrong schema versions are rejected.

## Actual Transcript

- `lattice story_advance --storyId=B-d8ef --phase=TEST`
  - REVIEW completeness: pass.
  - CLI gate preflight: all pass.
  - Configured validation: 43/43 commands passed.
  - Result: story advanced to TEST.

- `lattice validate --story=B-d8ef --json`
  - Configured validation: 43/43 commands passed.
  - Result: `status=pass`, `allPass=true`, summary `Project validation commands passed`.

- `lattice done_required_validate --storyId=B-d8ef --json`
  - `packages/main build`: PASS.
  - `root full test suite`: PASS.
  - Result: `status=PASS`.

- `lattice quorum_submit --storyId=B-d8ef --hostA=claude-cli --hostB=agy-cli --providerA=claude --providerB=agy --rounds=3`
  - Emitted 6 local non-authority host verdicts.
  - Review escalation: `ok=true`, `assuranceLevel=full-3x2`.
  - Review assurance floor: satisfied via full 3x2.

## Expected vs Actual Diff

- No functional difference observed.
- The implementation met the launcher-readiness, fallback-diagnostic, retired-marker, and canonical-host expectations.
- The formal project validation and DONE-required validation both passed on this machine.

## Closing Self-Check

- Real-machine test run: yes, `lattice validate --story=B-d8ef --json` and `lattice done_required_validate --storyId=B-d8ef --json`.
- Edge cases covered: yes, legacy probes, auth failures, wrong launchers, forged retired markers, wrong event type, wrong schema version, and two-review-ready-host fallback refusal.
- Unresolved TODOs: none observed for this story.
- User-visible outcome: the CLI now reports observable launcher readiness and blocks misleading fallback proof instead of silently relying on version-only availability.
- Pitfalls: Codex auth-profile accounts were unavailable, so 3x2 review assurance used Claude CLI plus Agy CLI rather than degraded fallback.
