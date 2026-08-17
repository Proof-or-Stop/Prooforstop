# Transcript Diff: B-73cf

Story: B-73cf
Purpose: verify the focused/full validation layering and timeout margin change from a real worktree run before DONE.

## Expected

- `lattice validate` with no focus remains the full configured validation path.
- `validate --focus=fast` runs only commands tagged with `focus: ["fast"]`.
- Focused validation output explicitly says it is not final full validation and not DONE-required proof.
- Timeout behavior remains bounded: hung commands are attributed with exit 124 and explicit `timeoutMs` still overrides the default.
- The baseline file remains immutable; this story writes a separate result artifact.

## Actual

- `npm --prefix packages/main run build` passed.
- `node packages/main/dist/tasks/validate-command-timeout-smoke.js` passed with 18 assertions.
- `node packages/main/dist/tasks/validate-focused-full-layering-smoke.js` passed with 10 assertions.
- `node packages/main/dist/cli.js validate --focus=fast --json` passed in about 11s, ran 3 configured commands, and returned:
  - provider: `lattice-verifier-configured-commands-focused`
  - focus name: `fast`
  - `finalFullValidation=false`
  - `doneRequiredProof=false`
- `lattice validate --story=B-73cf --json` passed the full 27 configured commands and reported verification intent coverage `9/9 covered`.
- `lattice story_advance --storyId=B-73cf --phase=TEST` passed after refreshing stale evidence; it ran full validation again and wrote `test-evidence.json`.
- `lattice done_required_validate --storyId=B-73cf --json` passed:
  - `packages/main build`: PASS
  - `root full test suite`: PASS
  - materialHash: `b5fe7c3cbd5474b4de3b2575ee61de3e45a881ead66b4b92ab125863d50c5473`

## Diff Notes

- Actual behavior matches the expected correctness contract.
- The only notable process difference was evidence freshness: reviewer metadata commits made the original checklist evidence stale, so `lattice verification_evidence_refresh_stale --storyId=B-73cf` was required before TEST could pass.
- The globally installed `lattice` binary was stale during DEV for the new `--focus` argument, so focused verification used the worktree local dist CLI until the story is merged/rebuilt. Full validation and DONE-required validation used the normal Lattice path.
- No wall-clock reduction is treated as proof. The proof is the preserved full default path, explicit focused non-DONE semantics, timeout attribution smoke coverage, and full validation PASS.
