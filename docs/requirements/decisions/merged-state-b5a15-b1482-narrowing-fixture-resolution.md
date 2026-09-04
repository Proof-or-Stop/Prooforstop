# Merged-state: B-5a15 causal receipts vs the B-1482 narrowing fixture

Status: RESOLVED. All `npm run test:narrowing-repin` cases pass on merged main.

This record supersedes an earlier draft that framed the failure as an open design
collision between B-5a15's execution-key dedup and B-1482's fixture, and recommended a
dedicated story. That framing was wrong, and the reasoning error is recorded below
because it is the reusable lesson.

## What the failures actually were

Three independent causes, none of them a conflict between the two stories' designs:

### 1. A real defect in B-5a15: the CAS index check refused legitimate failing receipts

`handlers/checklist.ts` required every receipt in a canonical import to be present in the
content-addressed store:

```ts
if (store.readCausalEvidenceReceipt(storyId, receipt.executionKey)?.receiptHash !== receipt.receiptHash) return false;
```

But B-5a15's own writer deliberately does not store non-PASS receipts
(`core/causal-evidence.ts`):

```ts
// A non-PASS result is an execution outcome, not a reusable CAS value.
if (args.receiptStore && receipt.reusable) {
  args.receiptStore.writeCausalEvidenceReceipt(key.identity.storyId, receipt);
}
```

So any evidence set containing a failing render was refused as
`causal_commit_snapshot_invalid`, as if the index had been tampered with. The two halves
of B-5a15 disagreed with each other; nothing about B-1482 was required to trigger it.

Fix: absence is evidence of tampering only for a receipt the writer would have stored.
A present entry must still match byte for byte in both cases.

```ts
if (stored) {
  if (stored.receiptHash !== receipt.receiptHash) return false;
} else if (receipt.reusable) {
  return false;
}
```

### 2. The fixture lacked a differentiator the execution key could see

Two renders of one pinned command must differ somewhere in
cwd + command + inputs + environment + storyFilesHash, or the second is correctly refused
as a duplicate. The render-mode file cannot be that differentiator: it is *material*, and
B-1482's narrowing proof requires both sides to share one recorded material binding — a
narrowing is only proven by two verdicts of the *same* repo state.

`storyFilesHash` is the correct seam. It is story metadata, excluded from `materialHash`
by `core/material-path-policy.ts`, and it genuinely moves between the two calls because
the first call records its own evidence. The fixture now commits that metadata — scoped to
the story directory, never `git add .`, which would stage the material mode file — between
the two renders.

### 3. The CLI-path cases were refused by the owner gate, not by any narrowing rule

`runCli` spawns the real CLI as a separate process whose ppid-derived session id differs
from the one holding the lease seeded in `makeEnv()`. Every CLI case failed with
"verification_pin_narrow is an owner-gated storyScopedMutating command". Pinning one
`PROOF_OR_STOP_SESSION_ID` for the suite makes both sides the same owner, which is what a
real operator session is. The gate is unchanged: a lease is still required and a different
id is still refused.

## No assertion was relaxed

The production change is the one in cause 1. Everything else is fixture setup that a real
operator session already has. `git diff` over the suite file shows zero changed
`assert.*` / `expectRejection` lines.

## The reasoning error worth keeping

The earlier draft rejected "commit the mode file" after measuring that `materialHash` did
not move. That measurement was taken on an **untracked** file. `currentMaterialHash` reads
`git ls-tree`, i.e. committed tree state, so an untracked file cannot appear in it by
construction. Re-measuring with the file tracked and committed showed the hash does move.

The false negative made a real seam look closed, which is what produced the "irreducible
design collision" conclusion and the recommendation to open a story. Two rules follow:

- When a measurement says a mechanism is inert, verify the measurement can observe that
  mechanism at all. A probe that cannot see its target reports absence either way.
- Before declaring a cross-story design conflict, check each story against itself. Here
  one story's writer and its own reader disagreed, and no amount of reasoning about the
  other story's contract could have found it.
