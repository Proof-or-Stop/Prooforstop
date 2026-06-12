# B-4a8e User-Visible Transcript Diff

## Expected

Running `session_brief` from a wrapper metadata root that is not a git repo but has `gitRoot: "clawcreek"` should show that the metadata root is non-git while the signed workspace is configured and usable:

```text
Signed workspace: OK
configured gitRoot: clawcreek
resolutionSource: configured-git-root
signedWorkspaceRoot: /Users/jek/Documents/ClawCreek/clawcreek
```

It should not leave the operator with only a generic `Non-git project` warning.

## Actual

Command:

```bash
node /Users/jek/Documents/Work/Orchestrate/.worktrees/B-4a8e/bin/lattice.js session_brief
```

Working directory:

```text
/Users/jek/Documents/ClawCreek
```

Observed transcript excerpt:

```text
## Signed workspace
  Signed workspace: OK
  configured gitRoot: clawcreek
  resolutionSource: configured-git-root
  signedWorkspaceRoot: /Users/jek/Documents/ClawCreek/clawcreek

Note: Metadata root is not a git repo; configured gitRoot supplies the signed workspace for git-backed operations.

## -> Next step
  Metadata root is not a git repo, but configured gitRoot resolves the signed workspace: /Users/jek/Documents/ClawCreek/clawcreek
```

## Diff Notes

No product-visible gap remains for the scoped issue. The Host/session brief now makes the resolved configured-gitRoot state visible while still stating that the metadata root itself is not a git repo.
