# B-4a78 TEST Transcript Diff

## Command

- `node packages/main/dist/cli.js validate --story=B-4a78 --json --forceTakeover`

## Result

- Verdict: PASS
- Validated commands: 44/44
- Final summary: Project validation commands passed
- Evidence file: `.lattice/story/actives/B-4a78/test-evidence.json`

## Binding

- Head hash: `adfbcbb5f810b03105b1fd1ec564a7476ce1b965`
- Material hash: `e729f0f9118f83f96430f0ae283a40772ed2f271a18c152d27a0f380095b6c46`
- Story files hash: `60ce2f4602ba7cc58929c2fc87c9704fe5b4fe9c5d19674a7e3880190ae18d0e`
- Timestamp: `2026-07-10T03:02:17.303Z`

## Expected vs Actual

| Area | Expected | Actual | Diff |
|---|---|---|---|
| Build | TypeScript build passes | `npm --prefix packages/main run build` passed | none |
| Focused smoke | Reviewer read evidence gate and read-log smoke pass | `reviewer-scan-budget-guard-smoke` passed | none |
| Full configured validation | All configured validation commands pass | 44/44 commands passed | none |
| Milestone ledger | M0-M5 remain covered with no next milestone action | `milestone_status` reports all ledger rows completed or not applicable | none |

## Notes

- The worktree-local CLI was used because the global `lattice` binary is older than this story's readManifest signature schema.
- The refresh changed only the TEST evidence binding timestamp/head hash; material hash and story-files hash remained stable.
