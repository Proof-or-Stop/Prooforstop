# Story query selection: first bounded RED/GREEN result

This is a query correctness and query-cost repair on main 0.3.296, performed only in the new Lab. It does not establish the root cause or resolution of hours-long Story delivery. The six broader verification obligations remain open.

## Root causes

1. `story_list --active` used a separate phase allowlist that omitted REVIEW. Both a direct REVIEW record and a main INIT_CHECK record projected from a linked REVIEW worktree disappeared from the active response.
2. The handler resolved each Story and hydrated its checklist, bugs, test evidence and process metrics before applying explicit active/phase filters. A query requesting three REVIEW rows still loaded details for every historical Story.

The candidate reuses the existing nonterminal phase set. It resolves workspace phases first, selects requested rows, and hydrates those rows only. Unfiltered dashboard behavior and global totals are preserved. This L0 query does not sign evidence or mutate a phase, lease, gate or real Story. Skipping excluded details is explicitly documented; a filtered listing is not an integrity audit of excluded Stories.

## Recorded verification

| Witness | RED | GREEN |
|---|---:|---:|
| Fixed in-memory Store sample, expected 9 active rows | 7 returned | 9 returned |
| Same 312-row sample, active detail-method calls | 1,248 | 36 |
| Same sample, REVIEW detail-method calls | 1,248 | 8 |
| Ten regression controls | 6 pass / 4 fail | 10 pass / 0 fail |
| Current repository data, REVIEW rows returned | 3 | 3, identical output digest |
| Current repository data, REVIEW detail-method calls | 1,548 | 12 |
| Three paired REVIEW queries: median handler time | 8.220 s | 2.782 s |
| Three paired REVIEW queries: observed range | 8.022–9.052 s | 2.728–2.817 s |

The same-output REVIEW query had an observed median reduction of 66.2% on this host, in an exploratory, REVIEW-only, order-imbalanced, high-selectivity case (3 of 387 rows; near maximum-benefit selectivity). RED was first in two of three pairs. This is not representative of typical filtered usage. This is three-pair exploratory latency, not a statistically confirmed performance PASS, not a universal speedup, and not the time for a Story. Timing excludes process startup, imports and preparation. Build/native regression durations include different work and are not used as a speedup measure.

The first timing attempt was invalid because another owner changed B-de09 configuration; every row is retained under timing-attempt1. A new REVIEW-only epoch retained the same pair count/order. All six output digests matched and 1418 observed synchronous string-path input files retained their digests across that epoch. This is limited input observation, not a complete filesystem/Git/runtime trace. Host load remains a confounder. The active query's output changes to repair completeness; no equal-output timing percentage is claimed for it. Its initial timing also overlapped native GREEN and is explicitly excluded from a formal performance claim.

## Source and test boundaries

- Main base: `442f6f38b6c6cb5f89521ddf9f79cabdd065a5c4` (0.3.296).
- Committed regression / native RED: `a385e46e60ff096344d4cec39e5d0fd0b6b1bca3`.
- Repair / native GREEN: `af32eb6b0b159630480e78acc16d8ed5165f3140`.
- Native pinned command: `node packages/main/tests/story-list-selection.test.mjs`.
- The synthetic test runs the real handler and workspace resolver against a real disposable Git/worktree topology and an in-memory StoryStore data adapter. It writes no Story JSON and does not simulate lifecycle admission or prove a CLI parser contract.
- The read-only real-data probe uses production handlers and file-backed stores. No old worktree runtime was migrated or given new admission rights.
- Existing Bug-summary, brief-output and process-fact regressions all passed. Source and raw outputs are retained.
- An initial relocated-dist setup failure was preserved, then corrected by placing the baseline build in its complete archived checkout layout. That setup error is not RED.

## Open issues

The observed resolver/main phase difference is a separate authority-contract investigation, not fixed by this patch. Old-worktree bootstrap rejection remains unchanged. Real Story end-to-end time and P95, live owner/reviewer adoption, broader review detection, heavy execution reuse, recovery extension and multi-host/soak gains have not been proven by this query repair.

Claude independently audited candidate af32eb6b0b, reproduced all original 10 controls, and returned PASS with five non-blocking documentation/test refinements. Those refinements are addressed in audit-dispositions.json; 14 controls now pass on the developer rerun. The bounded Claude follow-up returned PASS with no findings and independently ran all 14 controls. Its report says it could not find the dispositions file; that file exists and is bundled here, but this part was not read by the follow-up auditor. It reconciled behavior against the code and inherited the timing limitations from the first audit. The timing remains evidence from af32eb6b0b; later changes alter docs/comments and test coverage, not executable production logic. No main integration or version upgrade is authorized by this result.

## Evidence navigation

[Native RED](native-red.log), [native GREEN](native-green.log), [native record](native-status.json), [timing results](timing-results.json), [timing input digests](timing-inputs-before.json), [read-only probe](../query-read-probe.mjs), [source provenance](source-provenance.json), [regressions](regressions.json), [Claude audit](claude-audit/audit.json), [audit dispositions](audit-dispositions.json), [added boundary controls](audit-boundaries-green.log), [main preservation](main-preservation.json).

[Claude follow-up: 14 controls](claude-followup/audit.json). Its “no build verification” limitation means no independent build audit; the permitted test itself invokes ensure-dist before its controls.
