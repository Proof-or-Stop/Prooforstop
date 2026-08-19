# B-6529 Plan

## Goal

Prepare Cell 03 for provider execution by replacing the old pre-run dollar
guessing requirement with a frozen execution envelope and postflight
provider-reported usage accounting.

This story does not run provider calls. It makes the authorization state
mechanically clear so the future execution step can consume the envelope without
inventing budget, model, prompt, tool, owner, retry, or output semantics.

## Milestones

| Milestone | Status | Solves | Evidence |
| --- | --- | --- | --- |
| M0 Intake correction | Done | User rejected arbitrary dollar guesses; story now uses execution envelope plus postflight accounting. | `understanding.json`, `decision.json`, INIT reviewer passes |
| M1 Execution envelope | Pending | Freeze Cell 03 scope, row/task count, retry limit, timeout, token/output limits, and stop conditions. | `m2-cell03-execution-envelope.json`, checker assertions |
| M2 Target snapshots | Pending | Bind target E2 executor and same-family reviewer snapshot metadata without treating host labels as model snapshots. | `model-snapshot-lock.m2.json`, launch artifact, checker assertions |
| M3 Prompt/tool digests | Pending | Bind immutable prompt and tool-surface digests for future execution. | `m2-cell03-execution-prompt.md`, `m2-cell03-tool-surface.json`, launch artifact |
| M4 Ownership/duplicates | Pending | Record one Cell 03 owner and bounded retry/duplicate-row handling. | runner manifest + launch artifact assertions |
| M5 Output/accounting policy | Pending | Define result output, provider/model switch rejection, execution window, and postflight usage/cost accounting. | `m2-cell03-usage-accounting-policy.json`, `m2-cell03-result-write-policy.json` |
| M6 Review/test/DONE | Pending | Prove local checker rejects unsafe unlocks and preserves later-cell blocks. | `m2-provider-execution-check.mjs` PASS and Lattice gates |

## Acceptance Transcript

The user-facing completion signal is a real checker transcript in this shape:

```text
M2 provider execution checker passed: <n> assertions; <n> negative controls rejected
Cell 03 execution envelope: frozen
Pre-run dollar guess: not required
Provider calls from this authorization story: disabled
Postflight usage accounting: provider-reported usage required after execution
Cell 06 A2prime: blocked
```

## Design Decisions

- Use `authorization_ready_execution_not_run` semantics rather than
  `providerCallEnabled=true`.
- Do not require the human to guess a dollar amount before Cell 03 execution.
- Bound the future run by concrete execution controls: exact Cell 03 scope,
  row/task count, retry count, timeout, token/output limits, stop conditions,
  model snapshots, prompt/tool digests, and owner/duplicate policy.
- Record actual spend only after execution from provider-reported usage and a
  versioned pricing reference. Estimates are diagnostics only.
- Keep Cell 06, Cell 02, Cell 04, Phase 2, paper wording, runtime behavior, and
  playbook behavior out of scope.

## Verification Plan

- Extend `m2-provider-execution-check.mjs` to require the new envelope and
  usage-accounting policy.
- Add negative controls for:
  - reintroducing pre-run dollar cap as the only launch gate;
  - missing max retries, timeout, or token/output limits;
  - treating estimates as final usage;
  - setting provider calls or result rows true in this authorization story;
  - accepting host labels as model snapshots;
  - unlocking Cell 06 or later cells.
- Run:

```bash
node experiments/multi-model-ablation/m2-provider-execution-check.mjs
node experiments/multi-model-ablation/m2-launch-readiness-check.mjs
```

## Risks

- If the story removes dollar guessing but forgets retry/time/token bounds, it
  creates an unbounded execution path. The checker must fail that shape.
- If estimates are written as final usage, cost comparison becomes misleading.
  The accounting policy must keep estimate and provider-reported usage separate.
- If this story sets `providerCallEnabled=true`, authorization evidence becomes
  execution evidence. This story must keep actual provider calls disabled.
