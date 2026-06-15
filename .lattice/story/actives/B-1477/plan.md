# Plan: Lattice LLM Usage Ledger Execution Plan Document

## Scope

This story produces one execution-plan document for a future Lattice LLM usage ledger implementation. It does not implement CLI code, provider parsers, budget enforcement changes, runtime registry changes, or Authority Server integration.

The plan must follow these constraints:

- Do not optimize for the sake of optimization.
- Do not optimize arbitrarily.
- Only address the real correctness issue: Lattice cannot currently answer exact per-story LLM provider usage when providers do not report it.
- Follow consistency of logic between local Non-authority evidence and Authority Server receipt-backed proof.

## CHK-001

### Deliverable

Create `docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md`.

The document must specify:

1. The problem statement: prompt-size estimates are not true provider usage.
2. The intended ledger record model and measurement status taxonomy.
3. Local CLI behavior: record provider-reported usage when present, otherwise record unavailable.
4. Authority boundary: local ledger is Non-authority; Authority-backed usage requires verified receipt-backed proof.
5. Implementation touchpoints for a future code story.
6. Validation/smoke coverage required for future implementation.
7. Explicit non-goals and fail-closed behavior.

### Validation

Run document checks with `rg` to verify that the document includes the required terms and does not overclaim Authority completion. Then record docs_check verification evidence for happy, edge, and adversarial intents.

Required positive terms include:

- provider-reported
- measurementStatus
- unavailable
- local Non-authority
- Authority Server receipt
- no raw prompt
- no raw transcript
- fail closed

Required negative control: the document must not state that local ledger records alone imply `receiptVerified=true`, `productionDone=true`, `authorityDone=true`, or `fullAuthorityDone=true`.

### Rollback

If the document is incorrect, delete or rewrite only `docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md` inside this story worktree before committing. Do not alter existing requirement documents or source code.
