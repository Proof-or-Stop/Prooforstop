# B-5964 User-Value Transcript Diff

## Expected

Maintainer can run the process-fact contract verifier and observe one centralized,
hard-coded registry/config-table contract for Koala process facts:

- CLI command facts are aligned with command policy, lifecycle phase tools, and
  process-fact levels.
- Reviewer lanes, review-pass facts, finding facts, validation/evidence facts,
  and gate artifacts are registered as structured facts, not prompt-only prose.
- Source-first verification rejects drift in final registry composition and in
  mapped exports for `COMMAND_PROCESS_FACTS` and
  `PROCESS_FACT_REVIEWER_LANES`.
- Prompt wording remains auxiliary; CLI/handler/gate checks decide process
  truth.

## Actual

Command:

```bash
npm run test:process-fact-contract
```

Observed transcript highlights:

```text
Process Fact Contract
Prompt guides; CLI/handler/gate decides

Process Fact Registry
- entries: 110 (84 CLI, 3 runtime, 10 reviewer lanes, 13 artifacts)
- levels: L0=31, L1=14, L2=19, L3=3, L4=43
- kinds: artifact=6, command=63, execution-status=5, finding=3,
  gate-evidence=11, review-pass=1, reviewer-lane=10,
  runtime-behavior=3, signed-artifact=7, validation-status=1

Prompt drift scan: 27 reviewer prompt files checked
Process Fact Inventory
...
Process fact contract verified
```

Additional gate transcript:

```text
koala validate --channel --story=B-5964 --json
status: pass
summary: normal channel commits are authored by koala-implementer or
metadata-only Koala CLI commits; dispatch evidence covers CHK-001..CHK-004.
```

## Diff

No user-visible gap found. The maintainer-facing command now exposes the unified
registry inventory and verifies the hard-coded process-fact contract without
relying on stale dist output or prompt-only reviewer behavior.
