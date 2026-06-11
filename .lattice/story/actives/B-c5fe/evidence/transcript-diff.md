# Transcript / Diff Evidence

Story: B-c5fe
Date: 2026-06-10

## Expected User Outcome

The user asked for a detailed execution document for the future unattended
Authority strong-evidence chain. The document should make clear that a session
id alone is not sufficient, and should describe the required cross-plane work:
Python Authority Server, runner/host execution, Lattice CLI integration, and
cross-repo live validation.

## Actual Artifact

- `docs/requirements/decisions/authority-session-receipt-gate-execution.md`

The document now defines:

- Authority session identity lifecycle and receipt-backed gate consumption.
- Current boundary: `KOALA_AUTHORITY_SESSION_ID` is presence/config input only.
- Required binding from Authority URL, actor key, runner id, session id, job,
  evidence envelope, AuthorityReceipt, and gate predicates.
- Execution streams for Python Authority Server, runner/host execution plane,
  Orchestrate/Lattice CLI, and cross-repo validation.
- Phased rollout, fail-closed matrix, future story split, and implementation
  verification checklist.
- Per-gate `consumptionEvents` so `strongEvidenceConsumed=true` is derived from
  actual gate consumption, not static receipt eligibility or prose.

## Real-Machine Transcript

Command:

```bash
npm run build
```

Actual result:

```text
> koala@0.3.5 build
> cd packages/main && npm run build

> @koala-agent/core@0.3.5 build
> tsc
```

Command:

```bash
lattice validate --story=B-c5fe
```

Actual result summary:

```text
✓ Project validation commands passed
✓ package.json test script: npm test
✓ story-lifecycle (5 steps)
✓ gap-convergence (4 steps)
✓ ALL PASS
Verification intent coverage: 3/3 covered (0 required missing)
✓ CHK-001:happy:0 covered via docs_check
✓ CHK-001:edge:0 covered via docs_check
✓ CHK-001:adversarial:0 covered via docs_check
```

## Expected vs Actual Diff

- Expected: a detailed execution document exists.
  Actual: the document exists at the path above.
- Expected: the document rejects "session id exists" as sufficient evidence.
  Actual: it states `KOALA_AUTHORITY_SESSION_ID` is presence detection only and
  requires binding into Authority job/evidence/receipt/gate facts.
- Expected: the document describes all required planes, not only Python Server
  work.
  Actual: the execution streams section splits server, runner/host, Lattice CLI,
  and cross-repo validation responsibilities.
- Expected: the document avoids overclaiming fake/local/transport acceptance as
  strong evidence.
  Actual: the fail-closed matrix and receipt-backed gate predicate reject those
  paths.
- Expected: validation covers happy, edge, and adversarial acceptance.
  Actual: `lattice validate --story=B-c5fe` reports 3/3 required intents covered.

## Residual Risk

This story produced an execution document only. It intentionally does not claim
that the Authority Server, runner host, or Lattice CLI receipt-consuming gates
are implemented. Those are explicitly split into future implementation stories.
