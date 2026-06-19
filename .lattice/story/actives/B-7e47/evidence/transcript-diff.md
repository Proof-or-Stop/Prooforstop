# Transcript Diff: B-7e47

## Expected

The user-visible target from `understanding_set`:

```text
After the fix, running the Authority live Python E2E smoke against staging reaches
DONE preflight without the error "DONE enforce gate requires materialOverlapAudit
before Authority completion"; the terminal evidence shows
materialOverlapAudit.present=true, overlapCount=0, and the verified receipt proof
contains inputPayload.materialOverlapAudit.
```

## Actual Local Transcript

Command:

```bash
lattice validate --story=B-7e47 --json
```

Relevant output:

```text
✓ configured validate.commands[0]: npm --prefix packages/main run build
✓ configured validate.commands[1]: node packages/main/dist/tasks/authority-client-smoke.js
  GateEvaluateRequestContract materialOverlapAudit schema PASS changedFiles=[] actualFileOverlaps=[]
  materialOverlapAudit.present=true overlapCount=0
  signed DONE gate envelope contains decision.materialOverlapAudit before signature
  actualFileOverlaps preserved count=1
  authority completion loop no-overlap audit default PASS
  authority client smoke passed
✓ configured validate.commands[2]: node packages/main/dist/tasks/authority-completion-smoke.js
✓ configured validate.commands[3]: node packages/main/dist/tasks/review-pass-discard-smoke.js
✓ configured validate.commands[4]: node packages/main/dist/tasks/init-window-data-loss-smoke.js
Verification intent coverage: 15/15 covered (0 required missing)
```

Additional local smoke:

```bash
node packages/main/dist/tasks/natural-language-to-done-smoke.js
```

Relevant output:

```text
✓ natural-language-to-done E2E (M15) passed: one-sentence + requestFile NL -> Story -> typed Authority JobPlan -> provider/validate/evidence/gate -> verified native receipt -> authorityDone ...
```

Live staging smoke command:

```bash
node packages/main/dist/tasks/authority-live-python-e2e-smoke.js
```

Relevant output:

```text
authority live Python E2E smoke SKIPPED: set LATTICE_AUTHORITY_LIVE_URL, LATTICE_AUTHORITY_LIVE_PUBLIC_KEY, and LATTICE_AUTHORITY_CUSTOMER_API_KEY
```

## Diff Notes

- The local request-shape and caller-path tests now show `materialOverlapAudit.present=true overlapCount=0`.
- The signed DONE gate envelope includes `decision.materialOverlapAudit` before signature verification.
- Non-empty `actualFileOverlaps` is preserved, so real overlap evidence remains fail-closed.
- The real deployed staging smoke was not claimed as PASS because the live Authority environment variables were not present in this worktree.
