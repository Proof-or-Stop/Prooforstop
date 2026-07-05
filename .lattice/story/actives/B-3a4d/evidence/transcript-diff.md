# B-3a4d Live Smoke Transcript Diff

Captured at: 2026-07-05T02:43:28.594Z

## Expected

After DONE, `lattice milestone_closeout --storyId=<story>` prints the final milestone table instead of `Snapshot: missing`.

## Actual Command

```bash
node packages/main/tests/milestone-status.test.mjs
```

Exit code: 0

Stdout:

```text
ok milestone-status
```

Stderr excerpt:

```text
[0.0s] running milestone_closeout...
[0.0s] milestone_closeout done
[0.0s] running milestone_status...
[0.1s] milestone_status done
```

## Diff Notes

- The live smoke command passed on the local machine.
- The regression includes a real linked story worktree DONE path, verifies the story worktree is removed, then reads `proofbound.milestone_closeout.v1` from the canonical main root.
- The observed result matches the expected user value: the closeout snapshot is not treated as a transient worktree-only artifact.
- No unexpected output or failing assertion was observed.

## Bindings

- headHash: `3d036e15d28bccf8ff614bd5c93cda29e32deccb`
- materialHash: `3c7ba65c686e6df367573fb2ef34b94bfa4f0ecdec9f8732184a16074fe7e98e`
