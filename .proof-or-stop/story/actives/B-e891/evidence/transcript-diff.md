# B-e891 Real-Machine Transcript Diff

Date: 2026-07-01
Story: B-e891
Command surface: local CLI from `/Users/jek/Documents/Work/proofbound/.worktrees/B-e891`

## Expected

- The G02 smoke prints `parent-roadmap large-ledger G02 baseline smoke PASS`.
- The smoke proves the G02 parent ledger has 15 required rows, 14 generated closed rows, exactly one missing required row, and no full roadmap completion claim.
- The baseline document says G01-G02 are implemented only.
- The baseline document keeps G03-G10 as future/not implemented.
- The baseline document states the full 10x15 baseline is not complete.

## Actual Transcript

```bash
$ node packages/main/dist/tasks/parent-roadmap-large-ledger-g02-baseline-smoke.js
parent-roadmap large-ledger G02 baseline smoke PASS
```

```bash
$ rg -n "Status:|Current implemented slice|parent-roadmap-large-ledger-g02|G02 \||G03 \||G10 \||full 10x15 baseline is not complete|full 10x15|B-b596|B-e891" docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md
4:Status: baseline design / G01-G02 implemented only; G03-G10 future implementation
76:Current implemented slice: **G01-G02 only**. The full 10x15 baseline is not complete.
82:node packages/main/dist/tasks/parent-roadmap-large-ledger-g02-baseline-smoke.js
94:`packages/main/src/tasks/parent-roadmap-large-ledger-g02-baseline-smoke.ts`.
108:| G02 | Implemented as the missing-row negative-control 14-of-15 baseline smoke. |
109:| G03 | Future / not implemented. |
116:| G10 | Future / not implemented. |
164:| G02 | 14 rows closed, 1 required row missing | `no-full-roadmap-claim`, `openRows=1`, `invalidRows=1` | Prevents one missing milestone from being hidden by an otherwise large pass set. |
165:| G03 | 15 rows have prose closure but no machine evidence | `no-full-roadmap-claim`, evidence missing | Prevents documentation text from satisfying DONE.
172:| G10 | 15 rows initially stale, then refreshed to fresh | first blocked, then `full_roadmap_complete` | Proves the loop can recover safely without bypassing stale evidence checks.
182:| G02 | 15 | 14 | 1 | 0 | 0 | 1 | 0 | no |
183:| G03 | 15 | 0 | 15 | 0 | 0 | 0 | 0 | no |
190:| G10 | 15 | 15 after refresh | 0 after refresh | 15 before refresh | 0 | 0 | 0 | yes after refresh only |
194:The full 10x15 implementation should add or extend a smoke test similar to:
263:Story B-b596 implements the G01 positive-control smoke only. Story B-e891
264:implements the G02 missing-row negative-control smoke only. The full 10x15
```

## Diff Notes

- Expected G02 smoke PASS: met.
- Expected G02 implemented status: met.
- Expected G03-G10 future boundary: met.
- Expected full 10x15 not complete boundary: met.
- Expected no false-DONE claim: met; G02 is documented as 14-of-15 with `Full claim allowed` set to `no`.

## User-Value Check

The second baseline group now unlocks a concrete no-false-DONE guard: if a large parent ledger has 15 required milestones but one row is missing, Proofbound must surface that missing row and block the full roadmap completion claim.
