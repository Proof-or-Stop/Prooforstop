# B-bcd4 User-Value Transcript Diff

## Expected Outcome

- `/Users/jek/Documents/Work/proofbound` is the canonical active Lattice checkout.
- `/Users/jek/Documents/Work/Orchestrate` remains readable as local legacy evidence.
- Mutating Lattice commands against Orchestrate fail before handler dispatch and point to proofbound.
- B-3523 and B-fbb6 migrated worktrees are visible under proofbound, while Orchestrate no longer has active B-3523/B-fbb6 worktrees or story branches.

## Actual Transcript

### Retired Orchestrate Read-Only Inspection

Command:

```bash
node /Users/jek/Documents/Work/proofbound/.worktrees/B-bcd4/bin/lattice.js --root /Users/jek/Documents/Work/Orchestrate session_brief
```

Observed:

```text
# lattice session brief
Dashboard: Lifecycle DONE: 515/556 (93%)
No healthy active story.
Next step: story_reconcile dry run for 1 zombie story.
```

### Retired Orchestrate Mutating Command Rejection

Command:

```bash
node /Users/jek/Documents/Work/proofbound/.worktrees/B-bcd4/bin/lattice.js --root /Users/jek/Documents/Work/Orchestrate story_create <retired-root-smoke>
```

Observed:

```text
exitCode=1
Lattice root is retired: /Users/jek/Documents/Work/Orchestrate
Use canonicalRoot: /Users/jek/Documents/Work/proofbound
Command "story_create" resolves to mainSharedMutating and is blocked before handler dispatch.
```

### Migrated Active Worktree Recovery

Command:

```bash
test -d /Users/jek/Documents/Work/proofbound/.worktrees/B-3523 && \
  test -d /Users/jek/Documents/Work/proofbound/.worktrees/B-fbb6
```

Observed:

```text
proofbound migrated worktrees present: B-3523 B-fbb6
```

Command:

```bash
git -C /Users/jek/Documents/Work/Orchestrate worktree list --porcelain | rg 'B-3523|B-fbb6' || true
git -C /Users/jek/Documents/Work/Orchestrate branch --list 'story/B-3523' 'story/B-fbb6'
```

Observed: no output, meaning no active Orchestrate worktree or branch remains for B-3523/B-fbb6.

## Outcome Diff

No user-visible mismatch remains for the requested migration safety behavior. The old root is readable but no longer writable through the new retired-root guard, and the canonical root is named in the failure message.

## Limitations

- This does not normalize or finish B-3523/B-fbb6 business work; it preserves them as old worktrees under proofbound.
- Remaining Orchestrate lab/temp worktrees are still present as legacy artifacts, but they are not active B-3523/B-fbb6 story worktrees.
- The Orchestrate root still has unrelated user/experiment dirt; this story only changed its Lattice retirement config.
