# B-b596 Live Smoke Transcript Diff

Story: B-b596
Command: `node packages/main/dist/tasks/parent-roadmap-large-ledger-g01-baseline-smoke.js`
Captured at: 2026-07-01T00:53:53.285Z

## Expected User-Visible Output

Terminal shows `parent-roadmap-large-ledger G01 baseline passed`: 15 total rows,
15 closed rows, `full_roadmap_complete`, and no Authority or production
overclaim.

## Actual User-Visible Output

```text
parent-roadmap large-ledger G01 baseline smoke PASS
```

Exit code: `0`

## Diff Notes

The actual terminal output is intentionally terse. The detailed expected claims
are enforced by assertions inside
`packages/main/src/tasks/parent-roadmap-large-ledger-g01-baseline-smoke.ts`:

- exactly 15 generated `G01` rows;
- exactly 15 evaluated and closed rows;
- zero open, stale, deferred, invalid, or migration rows;
- `summaryClass=full_roadmap_complete`;
- a 14-generated-row negative control fails the full completion claim;
- local G01 proof does not become Authority, fullAuthority, production, or
  independent two-host evidence.

User-value verdict: pass. The user can run the documented command and receive a
successful G01-only smoke result without any full 10x15 or production overclaim.
