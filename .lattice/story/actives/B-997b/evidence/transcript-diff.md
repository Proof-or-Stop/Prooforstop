# B-997b Real-Machine Transcript Diff

## Expected

Wave 1 scope boundary controls should complete without expanding beyond M1-M3:

- `scope-contract` and `prewrite-guard` consume the same path classifier.
- Registered lifecycle/runtime artifacts are allowed as provenance/runtime paths.
- Unknown metadata, undeclared source edits, protected files, excluded paths, direct story JSON, and fixture paths remain blocked or warned according to the scope contract.
- Docs state that M4-M12, Authority receipts, Layer 4, customer key behavior, and production completion are future/non-goal work.
- `lattice validate --story=B-997b` reports project validation pass and 24/24 verification-intent coverage.

## Actual Transcript

Command:

```bash
lattice validate --story=B-997b
```

Observed result on this worktree:

```text
Project validation commands passed.
configured validate.commands[0]: npm --prefix packages/main run build
configured validate.commands[1]: node packages/main/dist/tasks/authority-client-smoke.js
configured validate.commands[2]: node packages/main/dist/tasks/authority-completion-smoke.js
Verification intent coverage: 24/24 covered (0 required missing)
```

Additional focused checks run on the same material:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/prewrite-guard-smoke.js
node packages/main/dist/tasks/scope-contract-smoke.js
node scripts/verify-process-fact-contract.mjs
```

Observed focused results:

```text
build passed
prewrite guard smoke passed
scope contract smoke passed
Process fact contract verified
```

## Diff Notes

No user-value difference from the expected outcome was observed. The first REVIEW round found one high issue, `B-997b:F-001`, where `prewrite-guard` had not yet consumed the shared classifier. That issue was fixed, resolved with strong evidence, and revalidated. The final TEST transcript matches the expected pass condition.

## Acceptance

Accepted for local non-Authority completion evidence. This file is lifecycle transcript evidence only; it does not claim Authority receipt verification, `authorityDone`, `fullAuthorityDone`, `productionDone`, or `receiptVerified`.
