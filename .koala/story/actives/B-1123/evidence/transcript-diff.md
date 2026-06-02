# B-1123 user acceptance transcript diff

## Expected outcome

Developers can run focused authority runner tests and see:

- runner contract/signing smoke passes with deterministic canonicalization, Ed25519 sign/verify, and L2+ boundary coverage
- runner authority client smoke passes with all expected runner endpoints exercised and off mode performing zero network calls
- ordinary local/shadow evidence is not promoted to receipt-backed L2+

## Actual transcript

Command:

```bash
npm run test:authority-runner-contracts
```

Observed:

```text
✓ authority runner contracts smoke passed: deterministic canonicalization, sign/verify, and L2+ boundary preserved
```

Command:

```bash
npm run test:authority-runner-client
```

Observed:

```text
✓ authority runner client smoke passed: 7 runner endpoints hit, off-mode performs zero network calls
```

## Outcome diff

No user-visible mismatch. Both expected focused smoke commands pass and their success messages explicitly cover the authority runner contract, signing, endpoint, and off-mode no-network behavior promised by the story.

## Notes

This acceptance evidence verifies the TypeScript/Lattice client foundation only. It does not claim production L2+ authority receipt behavior; that remains reserved for later runner/server milestones.
