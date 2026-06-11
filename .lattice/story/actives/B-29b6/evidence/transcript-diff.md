# B-29b6 User-Value Acceptance Transcript Diff

Date: 2026-06-02
Story: B-29b6
Phase tested: TEST
Worktree: `/Users/jek/Documents/Work/Orchestrate/.worktrees/B-29b6`

## Expected

The Lattice Parallel Wave commands should be usable from the built local Koala CLI in an active story session:

- `parallel_wave_create` creates a parseable `koala.parallel_wave.v1` projection.
- `parallel_wave_inspect` reads that projection and reports inspection counts without refreshing evidence.
- `parallel_plan` produces a `koala.parallel_plan.v1` execution plan.
- All outputs preserve the authority boundary: `productionDone=false`, `authorityChanged=false`, and `receiptRefs=[]`.
- Conditional host capability gaps remain visible degradations and do not become receipts.

## Actual Transcript

Temporary artifacts were written outside the repository:

`/tmp/koala-b29b6-acceptance.ambrSs/`

Commands:

```bash
node packages/main/dist/cli.js --root . parallel_wave_create \
  --storyIds='["B-29b6"]' \
  --hosts='["codex"]' \
  --waveId='acceptance:B-29b6' \
  --format=json \
  --output /tmp/koala-b29b6-acceptance.ambrSs/wave.json

node packages/main/dist/cli.js --root . parallel_wave_inspect \
  --file=/tmp/koala-b29b6-acceptance.ambrSs/wave.json \
  --format=json \
  --output /tmp/koala-b29b6-acceptance.ambrSs/inspect.json

node packages/main/dist/cli.js --root . parallel_plan \
  --file=/tmp/koala-b29b6-acceptance.ambrSs/wave.json \
  --format=json \
  --output /tmp/koala-b29b6-acceptance.ambrSs/plan.json
```

Observed summary:

```json
{
  "waveSchema": "koala.parallel_wave.v1",
  "waveId": "acceptance:B-29b6",
  "storyCount": 1,
  "authority": {
    "productionDone": false,
    "authorityChanged": false,
    "receiptRefs": [],
    "notes": [
      "Parallel Wave is collection-level scheduling and recovery guidance only; it does not mutate story authority, verify receipts, or satisfy DONE.",
      "Production authority remains blocked for hosts without available receipt verification (codex:receipt-verify=conditional)."
    ]
  },
  "inspectSchema": "koala.parallel_wave_inspect.v1",
  "inspectStoryCount": 1,
  "planSchema": "koala.parallel_plan.v1",
  "parallelDevCandidates": ["B-29b6"],
  "planOnlyStories": [],
  "blockedStories": []
}
```

Additional observed details:

- `parallel_wave_create` wrote a 4798-byte wave JSON file.
- `parallel_wave_inspect` wrote a 5045-byte inspection JSON file.
- `parallel_plan` wrote a 5223-byte plan JSON file.
- The host candidate for `codex` reported conditional `browser-automation`, `evidence-submit`, and `receipt-verify` capabilities.
- `receipt-verify=conditional` produced a visible blocking degradation for productionDone, as expected.

## Diff

No user-value mismatch found.

- Expected parseable wave JSON: actual `koala.parallel_wave.v1`.
- Expected parseable inspect JSON: actual `koala.parallel_wave_inspect.v1`.
- Expected parseable plan JSON: actual `koala.parallel_plan.v1`.
- Expected no authority mutation: actual `productionDone=false`, `authorityChanged=false`, `receiptRefs=[]`.
- Expected visible degradation for missing/conditional receipt verification: actual productionDone block note present.

## Non-Authority Boundary

This transcript is TEST acceptance evidence only. It does not satisfy DONE by itself, does not verify a server receipt, and does not claim production authority.
