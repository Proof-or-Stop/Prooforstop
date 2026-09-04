## Trigger Event

On 2026-09-04, after the CLI version bump to 0.3.275 landed on main as commit 90902a8345 alongside the B-1482 merge 287585dea5, every session on this machine got `permission denied` from the globally installed `proof-or-stop`, because `packages/main/dist/cli.js` had been emitted with mode 644. Another session diagnosed and repaired it with `chmod +x packages/main/dist/cli.js`. The blast radius is machine-wide rather than per-worktree: the global install is a symlink chain from `/opt/homebrew/bin/proof-or-stop` into `/opt/homebrew/lib/node_modules/@proof-or-stop/core`, itself a symlink to `packages/main` in this repository, so one shared `dist` means a lost exec bit takes down every session and every worktree at once. This has happened before and is recorded in session memory as a recurring trap.

## Key Insights

The following were verified against the tree at the time of writing, not taken on report.

`packages/main/src/cli.ts` line 1 is `#!/usr/bin/env node`, and `packages/main/package.json` declares `"bin": {"proof-or-stop": "dist/cli.js"}`. TypeScript's emit does not carry an executable mode, so a genuine compile produces mode 644 regardless of the shebang. Nothing is being forgotten by a caller; the emit itself is the source.

The reason the tree is not broken constantly is the content-hash fast path in `scripts/build-main-with-binding.mjs` (line 22 onward): the binding is a purity check that lets the script exit before emitting, so most builds never touch `dist`. Only a real rebuild, such as a version bump, drops the bit.

The open question raised with the diagnosis has now been answered, and it changes the fix. `scripts/full-suite-build-binding.mjs` line 32 hashes each file's path and `readFileSync` content only; no `statSync`, no mode, anywhere in the file. So the binding is content-only, and a `dist` whose exec bit was lost still verifies. A chmod inside the build is therefore necessary but not sufficient on its own: it prevents future occurrences, but it cannot repair a tree already in the broken state, because the fast path will keep skipping the rebuild that would apply it. Recovery needs either a mode check on the verify side or a manual chmod.

## Solution Tradeoffs

Placing the chmod inside the locked critical section of `scripts/build-main-with-binding.mjs`, after the atomic staging swap and before `writeBuildBinding`, keeps it within the same atomic step that readers observe; the surrounding comments at lines 28 to 32 describe that section and why `writeBuildBinding` sits inside the lock. Driving the mode from the `bin` map rather than a hardcoded path covers a second binary added later. The alternative, a chmod in each caller, was rejected in the diagnosis because it repeats the fix at every call site and misses the ones nobody remembers.

Whether to also make the binding mode-aware is a genuine tradeoff. The recorded preference, from the session that diagnosed the breakage and independently re-read the binding, is to put an executable-mode assertion on the verify path and keep mode out of the hash. Folding mode into the digest buys self-healing but coerces a permission problem into a content-identity problem: the binding would report that dist does not match source for a tree that matches perfectly, and it would become sensitive to umask, to a filesystem that does not carry the bit, and to a platform that models it differently. A verify-path assertion states the true thing instead, that the content is fine and the mode is wrong, and it can name the exact chmod. There is a second cost: the comment in treeDigest claims byte-identical continuity with the pre-B-1734 implementation, so adding an input would invalidate every existing binding at once and force a global rebuild.

## Conversational Texture

Raised by another session on this machine after it repaired the breakage, with the request that this session own the record because it had no story open to carry it. The structural diagnosis is theirs; the verification of the shebang, the bin map, the fast path and the content-only binding is recorded above from the tree itself. The observation that this recurs, and that a fix belongs in the build rather than in the operator's habits, is the reason it is written down instead of being chmod-ed away again.
