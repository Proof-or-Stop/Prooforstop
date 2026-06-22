# B-bcd4 Execution Plan

## Scope Principles

- Keep the guard in the Lattice workflow layer, not in a Codex, Claude, shell, or GitHub-specific namespace.
- Reuse existing command ownership / mutation policy; do not add a second arbitrary command taxonomy.
- Fix only the correctness issue: retired roots must reject new mutating writes while preserving read-only legacy evidence access.
- Preserve B-3523 and B-fbb6 as migrated worktree evidence; this story does not finish their business work.

## CHK-001 Define Retired-Root Configuration Semantics

Implement the smallest config surface needed to express a retired project root:

- `retiredRoot: true` marks the current Lattice metadata root as read-only legacy evidence.
- `canonicalRoot` names the active root agents should use for new writes.
- Non-retired configs continue to resolve exactly as before.
- A retired root without a usable `canonicalRoot` fails with a clear configuration error instead of silently allowing writes.

Expected user-visible proof: config inspection and smoke output include `retiredRoot: true` and `canonicalRoot: /Users/jek/Documents/Work/proofbound` for the old Orchestrate root, while proofbound does not show a retired-root warning.

## CHK-002 Enforce Retired-Root Guard Before Mutating Commands

Wire the guard before handler dispatch so it applies uniformly to Hosts and Agents. The guard must consult the existing command policy / ownership classification and reject only mutating workflow commands. Read-only commands such as `session_brief`, `story_get`, and `aux_doc_list` remain usable for old evidence lookup.

Representative blocked commands:

- `story_create`
- `story_advance`
- `checklist_update`
- review/finding/pass writers
- validation or evidence writers that bind story state

Expected user-visible failure text should name both roots, for example:

```text
Lattice root is retired: /Users/jek/Documents/Work/Orchestrate
Use canonicalRoot: /Users/jek/Documents/Work/proofbound
```

## CHK-003 Add Focused Tests For Retired-Root Behavior

Add a focused smoke test that creates temporary Lattice config roots and verifies:

- read-only commands remain allowed for retired roots;
- representative mutating commands fail closed before writing story state;
- malformed retired-root config without canonicalRoot is rejected;
- non-retired proofbound behavior remains unchanged;
- any explicit override, if introduced, is narrow and visible in output.

The test should be project-native and cheap enough to run in routine validation. It should not depend on Codex or Claude assets.

## CHK-004 Document Orchestrate Retirement And Migration Recovery Path

Add or update documentation that says:

- `/Users/jek/Documents/Work/proofbound` is the canonical active checkout;
- `/Users/jek/Documents/Work/Orchestrate` is read-only local legacy evidence;
- B-3523 and B-fbb6 were preserved under proofbound `.worktrees`;
- old Orchestrate should not receive new story/checklist/review/test writes;
- the local evidence remains available for paper/research use and is not meant for GitHub publication.

The wording must stay Host-neutral and Agent-neutral.

## CHK-005 Verify Migrated Active Stories Are Visible In Proofbound And Absent From Orchestrate Active Worktrees

Record acceptance evidence that:

- `/Users/jek/Documents/Work/proofbound/.worktrees/B-3523` exists;
- `/Users/jek/Documents/Work/proofbound/.worktrees/B-fbb6` exists;
- Orchestrate no longer has active story branches or healthy active worktrees for B-3523/B-fbb6;
- any remaining lab or temporary Orchestrate worktrees are reported separately and not counted as active migrated stories.

This is verification and documentation only; do not normalize, rebase, finish, or merge the migrated story branches in this story.

## Validation Checklist

- `npm --prefix packages/main run build`
- focused retired-root smoke test command
- `node bin/lattice.js --version`
- retired Orchestrate read-only command smoke
- retired Orchestrate mutating command rejection smoke
- proofbound migrated worktree directory checks for B-3523 and B-fbb6

## Rollback

If the guard blocks read-only evidence access or cannot distinguish mutating commands reliably, revert the guard wiring and keep the existing local Orchestrate pre-commit freeze as the temporary safety net. Do not delete legacy evidence during rollback.
