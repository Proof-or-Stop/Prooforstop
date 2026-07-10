# B-d8ef Real-Machine Transcript Diff

Story: B-d8ef - Probe canonical host execution readiness and observable launchers
Phase observed: TEST
Observed at: 2026-07-09T22:16:40Z
Observed head: 7bd2e0314401d734594012f89f08df64673eceab
Material hash: 01fcc9bbdc043169a493838ea1877eeb5a8d5881b930fe1ff309ecf95f873fae
Story files hash: 904e54ad723b2cd6bf1dd915e087437307ecc7b6d46e04a0b0ac1740f83a9924

## Expected

- Review host readiness is based on executable noninteractive launcher readiness, not only binary or version presence.
- Claude reviewer launchers use observable print mode with verbose stream-json output.
- Codex auth failures and agy wrong-launcher templates are classified as not review-ready.
- Legacy or version-only host probes do not satisfy non-human degraded fallback proof.
- Review fallback diagnostics use `reviewReadyHostCount` and block single-host fallback when two canonical hosts are review-ready.
- v2 host readiness proof rejects forged readiness counts, contradictory rows, wrong schemas, and retired completion markers.

## Actual Transcript

- `lattice story_advance --storyId=B-d8ef --phase=TEST`
  - REVIEW completeness: pass.
  - CLI gate preflight: all pass.
  - Existing validation PASS was fresh enough for REVIEW -> TEST.
  - Result: story advanced to TEST.

- `lattice verification_evidence_refresh_stale --storyId=B-d8ef --dryRun --json`
  - Result: no stale verification evidence.

- `lattice validate --story=B-d8ef --json`
  - Ran 43 configured validation commands on this machine.
  - Result: `status=pass`, `allPass=true`, summary `Project validation commands passed`.
  - Verification coverage: total 10, required 9, covered 10, missing required 0.

## Expected vs Actual Diff

- No functional difference observed.
- Launcher readiness, fallback diagnostics, auth failure handling, wrong-launcher handling, and forged-proof rejection all matched the expected behavior.
- The TEST-phase validation run passed on the current workspace without stale verification evidence.

## Closing Self-Check

- Real-machine TEST run: yes, `lattice validate --story=B-d8ef --json`.
- Edge cases covered: yes, legacy probes, auth failures, wrong launchers, forged or contradictory readiness counts, wrong schemas, and two-review-ready-host fallback refusal.
- Unresolved TODOs: none observed for this story at TEST validation.
- User-visible outcome: the CLI reports executable launcher readiness and avoids misleading fallback proof based only on binary/version availability.
