# B-9d6c User-Value Transcript Diff

## Expected

The user asked for a formal unlock artifact isolation guard that prevents stale
or mixed proof artifacts from polluting Layer 2 Engineering and Layer 3 Loop
Engineering formal unlock roots.

Expected observable behavior:

- Clean formal Layer 2/3 proof roots still pass.
- Mixed `suiteRunId`, wrong `claimTarget`, `localOnly=true`, stale material, or
  Authority-overclaim artifacts fail closed.
- Lattice CLI remains non-authority and does not claim Authority Server receipt
  verification, Layer 4 Production Safety, or global production readiness.
- The execution document states the implemented boundary without promising
  more than the code enforces.

## Actual

Commands run on the story worktree:

```text
npm --prefix packages/main run build
PASS

npm --prefix packages/main run test:lattice-baseline-smoke
PASS

lattice validate --story=B-9d6c --json
PASS
Verification intent coverage: 9/9 covered
```

Independent review evidence:

```text
Claude host:
  koala-review-concept PASS
  koala-review-docs PASS

Codex host:
  koala-review-quality PASS
  koala-review-test-coverage PASS
  npm --prefix packages/main run test:lattice-baseline-smoke PASS
```

## Diff Notes

No user-visible mismatch remains.

One review-time correction was made: the execution document originally described
`headHash` as a current-HEAD root invariant. Smoke validation showed this would
conflict with the existing formal proof model where proof artifacts can be
generated against a source HEAD and then committed as artifact material. The
document now records `headHash` as a source binding, while stale proof-root
blocking remains based on `materialHash` and rebuilt accepted-report bindings.

Layer 4 remains locked in this story. Authority Server receipts are not
verified or simulated by the local CLI evidence.
