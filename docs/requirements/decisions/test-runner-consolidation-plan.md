# Test Runner Consolidation Plan

## Canonical root-suite execution (B-9812)

The root `npm test` contract is now distinct from smoke auto-discovery. It uses
`full-suite-runner.ts`, whose explicit resource-classified inventory is checked
bidirectionally against `test:serial-reference` before execution. Unknown,
duplicate, missing, or extra members fail closed. Compatible isolated/read-only
members share a bounded worker pool; repo writers take an exclusive lock.
Timeouts terminate the member process tree and verify it is gone before
publishing a terminal result: `terminateProcessTreeAndVerify` freezes the
captured tree (SIGSTOP until two stable snapshots add no new members), then
SIGKILLs and re-polls until no captured PID remains, so a detached descendant
that called `setsid` cannot outlive the member. That retry is bounded by the
cleanup budget rather than unbounded: a process that can never be reaped (for
example one wedged in uninterruptible sleep) would otherwise spin the loop
forever, so on budget expiry the runner records the surviving PIDs as a
lifecycle error and stops retrying. Exiting that way is still fail-closed — the
terminal result is negative and never claims a clean tree while a captured child
may remain alive. Captured ownership is keyed on
`(pid, birthIdentity)` — `parseProcessRows` reads a per-process birth fact from
`ps` alongside pid/ppid/pgid — so a PID that exits and is recycled before
terminal reconciliation is permanently revoked rather than re-adopted, and is
never signalled. Inspection failures are recorded and fail closed; they are
never treated as revocation. Output is bounded, and a first-run FAIL
or TIMEOUT is terminal: the canonical path never retries to green. The prior
`run-all-smokes` discovery runner remains available for its broader noncanonical
smoke/coverage use cases.

Exclusive path claims may additionally declare runner-cleanable ownership. The
runner records each canonical target's pre-spawn existence, type, and owner
marker, limits targets to the exact project `.proof-or-stop/runtime` and
`.proof-or-stop/locks` subtrees, rejects any pre-existing/symlinked/out-of-bound target
before spawn, and uses a per-launch ownership token. PASS requires every declared
owned target already absent. FAIL, TIMEOUT, and INTERRUPT remove a target only
when it was absent before launch and now carries the exact launch token; an empty,
missing-marker, tampered, foreign, or nonempty target is retained and makes the
result fail closed.

The canonical runner smoke itself creates the fixed-path collision fixture and
probes port 43127, so its manifest declares the same exclusive fixed-path and
fixed-port keys as the resource sentinel. This keeps the real fixture writer and
port probe mutually exclusive with the sentinel at all worker counts; the smoke
is not treated as a read-only member.

### Quorum-submit bounded shard execution (B-e40f)

The quorum-submit smoke remains one configured black-box command and one
canonical 73-case inventory. Its thin parent groups that inventory into the
four declared shards and runs at most `--jobs=<n>` shard processes at once;
each shard process executes its cases serially. `jobs=1` therefore remains the
serial compatibility oracle, while the configured validation row explicitly
uses `--jobs=2`. Empty work, duplicate executable identities, missing shard
identity, and out-of-range job counts fail closed before worker allocation.

The parent creates one identity-recorded worker root per shard beneath a single
owned temporary base and overrides `TMPDIR`, `TMP`, `TEMP`, and the quorum
fixture base for that child. A worker root is removed only after its captured
process tree is gone and its path/device/inode identity still matches; failure
or timeout is never retried. Cancellation stops dequeueing; POSIX hosts signal
the owned process group with bounded TERM then KILL, while Windows uses the
repository-standard `taskkill /PID <pid> /T /F` tree operation. Either branch
reports process and temporary residue rather than converting an unknown signal
or cleanup result into PASS.

The configured resource claim is consequently one shared read of the Git
common directory. Runtime resource records are nonce/run/callback-bound,
no-follow append-only witnesses for canonical repository reads and isolated
fixture writes. Callback, fixture, and resource trace sinks are accepted only
as distinct, canonical, single-link files strictly outside both the worktree
and the Git common directory resolved from canonical `cwd` with ambient
`GIT_*` redirection removed; each append rechecks the pinned device and inode
with no-follow open semantics. These traces are deliberately bounded
witnesses, not a claim to be a complete operating-system syscall audit. The
long-running contract separately checks callback timelines, worker PIDs, exact
result identities, parent-owned root cleanup, and forged repository-write or
overlapping-root rejection. No speed gain is inferred from this design alone;
the B-e40f performance contract must measure the fixed baseline, `jobs=1`, and
`jobs=2` on an idle frozen host before any performance acceptance claim is made.

This decision document records the chosen architecture for consolidating the
project's test runner and decomposes the implementation into follow-up Proof-or-Stop
stories. The deliberation history is captured under Proof-or-Stop story **B-35aa**.

## Current State

Numbers pinned at decision time (2026-06-17):

| Metric | Value |
|---|---|
| `packages/main/src/tasks/*-smoke.ts` files | **151** |
| Total smoke source lines | **~70,280** |
| Average lines per smoke | **~466** |
| Largest smoke | `flow-stability-smoke.ts` (3,831 lines) |
| `test:*` npm script entries | **258** (111 in root `package.json` + 147 in `packages/main/package.json`) |
| `scripts/verify-*.mjs` | **49** |

Each smoke is a standalone executable invoked as:

```
node packages/main/dist/tasks/<name>-smoke.js
```

This pattern — **dist-standalone-executable** — is a deliberate architectural
choice: smokes run against the **compiled dist artifact**, simulating an OSS
user invoking the published CLI. Setup is typically `mkdtempSync()` + spawning
the CLI under test + asserting on its stdout / stderr / exit code / on-disk
state, then cleaning up. Smokes are **integration scenarios**, not unit tests.

### Existing decisions that constrain the architecture

- **`testing-infra.md`** (the project-level validation entry) documents:
  - **Project-native validation policy**: prefer `npm test` / `pytest` /
    `go test` / `cargo test` etc. as the validation entry; Proof-or-Stop does not
    require any project to use a TypeScript `validate.ts`.
  - **General black-box command** as a first-class executor (applicable to
    `go test`, `pytest`, `ctest`, `mvn test`, `swift test`, `xcodebuild test`,
    and equivalently `node dist/tasks/<name>-smoke.js`).
- **`testing-completeness.md`** documents the `@flow` / `@test` annotation
  contract and the layered `gap_analyze` severity. It does not constrain
  runner choice.

The dist-standalone-executable pattern aligns with `testing-infra.md`'s
general-black-box-command policy: each smoke IS a black-box command.

## Paths Considered

### Path A — Vitest migration

Rewrite every smoke into `describe(...) / it(...)` blocks, adopt Vitest as the
runner, run smokes inside Vitest's worker pool.

- **Pros**: standard JS test ecosystem; IDE integration (VS Code test panel);
  built-in parallelism, coverage, watch mode, and rich reporters.
- **Cons**:
  - **Rewrite cost** — 151 smokes × ~466 lines average = ~70k lines of
    spawn-CLI integration logic to refactor.
  - **Architecture mismatch** — smokes are spawn-child-process scenarios with
    tmpdir lifecycles; Vitest's worker pool fights with that pattern (each
    smoke needs its own process anyway, and Vitest's isolation model is
    optimized for in-process units).
  - **Policy mismatch** — adopting Vitest as the validation contract conflicts
    with `testing-infra.md`'s **language-agnostic** black-box-command policy.
    Vitest is JS-only; the project's policy is intentionally language-agnostic.
  - **Lock-in** — switching runner later means another migration of the same
    magnitude.

### Path B — In-house runner + manifest + c8 coverage *(chosen)*

Build a small TypeScript runner (under `packages/main/src/tasks/`) that:

- scans `packages/main/src/tasks/*-smoke.ts` (or any directory configured by a
  manifest), discovers smokes, runs them in parallel, and reports per-smoke
  pass/fail + an aggregate summary;
- reads a **manifest** (JSON or TSV checked into the repo) controlling:
  - default parallelism (typically `os.cpus().length`),
  - per-smoke timeout,
  - optional tags (e.g. `wrapper-root`, `authority`, `dispatch`),
  - opt-in or opt-out flags;
- exposes a handful of orchestration entries instead of 258 individual scripts:
  - `npm run test:all` — every smoke in parallel
  - `npm run test:tag <tag>` — only smokes carrying `<tag>`
  - `npm run test:select <pattern>` — only smokes whose name matches
- wraps **c8** to produce coverage (`packages/main/coverage/`) and LCOV.

- **Pros**:
  - **Preserves the 70k existing lines** — smokes are untouched; only their
    invocation orchestration changes.
  - **Aligns with `testing-infra.md`** — the runner orchestrates
    general-black-box-commands; each smoke is still a self-contained black-box
    executable.
  - **Delivers all three stated benefits** — parallelism (CI speedup),
    coverage (c8), and ergonomics (one entry + selectable smokes).
  - **No framework lock-in** — the manifest is a flat data format; swap the
    runner later if a better choice emerges.
- **Cons**:
  - **Maintain an in-house runner** (~200 LOC; the smoke discovery + parallel
    pool is the only non-trivial part).
  - Tooling like Vitest's UI is not free; we'd build whatever ergonomics we
    want incrementally.

### Path C — Path B minus c8

Same as B but without c8 wiring.

- **Pros**: smallest scope.
- **Cons**: misses one of the three stated benefits (measurable coverage); c8
  wiring is a trivial wrapper. No reason not to include it.

## Chosen Path: B — In-house runner + manifest + c8 coverage

**Rationale:**

1. Smokes are **spawn-CLI integration scenarios**, not unit tests. They
   intentionally fork a child process to invoke `dist/cli.js`, set up a tmpdir,
   assert on real on-disk state, and clean up. This is the entire point of the
   pattern: it mirrors what an OSS user does when running the published CLI.

2. The **dist-standalone-executable pattern** aligns with `testing-infra.md`'s
   general-black-box-command policy. The policy is intentionally **language-
   agnostic** ("`go test`, `pytest`, `ctest`, `mvn test`, `swift test`,
   `xcodebuild test`, etc."). Adopting Vitest would silently narrow that
   contract to JS-only — a regression against an existing decision.

3. The chosen path is a **thin orchestration layer**, not an architectural
   replacement. The 70k existing lines of smoke logic become **inputs** to the
   runner; nothing in the smokes themselves needs to change. Parallelism comes
   from the runner's worker pool; coverage comes from c8 wrapping the runner;
   ergonomics come from `test:all` / `test:tag` / `test:select`.

4. **No framework lock-in.** If a future Proof-or-Stop contributor wants to swap the
   in-house runner for some new option, they replace the runner without
   touching any smoke.

## Follow-up Proof-or-Stop Stories

Each follow-up story goes through its own full Proof-or-Stop workflow (INIT →
INIT_CHECK → PLAN → DEV → REVIEW → TEST → DONE). One-paragraph scope sketches
follow; future `story_create` calls may quote them verbatim.

### B1 — Runner skeleton + manifest format + `test:all` entry

**Scope:** create `packages/main/src/tasks/run-all-smokes.ts` and its dist
artifact. Scan `packages/main/src/tasks/*-smoke.ts` (or a manifest-configured
list). Spawn smokes in parallel (default = `os.cpus().length` workers). Read a
manifest file (`packages/main/smoke-manifest.json`) controlling
parallelism / per-smoke timeout / optional tags. Add `test:all` npm script at
root referencing `node packages/main/dist/tasks/run-all-smokes.js`. Support
`--tag <tag>` and `--select <pattern>` argument filtering.

**Acceptance:** `npm run test:all` runs every smoke in parallel and reports
per-smoke `PASS`/`FAIL` + aggregate `<n>/<m> passed in <duration>`; running
with `--tag <tag>` or `--select <pattern>` filters; **existing individual
`test:*` scripts are untouched** (B2 collapses them separately so B1 can land
without breaking anything).

### B2 — Collapse 258 `test:*` scripts into manifest entries

**Scope:** mechanical migration. For each individual `test:*` entry in root
`package.json` and `packages/main/package.json`, add a row to the manifest
(script-name, tag(s), timeout, opt-flags). Remove the individual npm script
**after** verifying the manifest entry runs equivalently via `npm run test:all
--select <name>`. Keep a thin compatibility shim (e.g. a top-level
`npm run test:legacy <name>` that proxies to `--select`) for any external doc
or script that references the removed names; CHANGELOG documents the removal.

**Acceptance:** root + `packages/main` `test:*` script count drops from 258 to a
small orchestration set (≤10: `test:all`, `test:tag`, `test:select`,
`test:coverage`, `test:legacy`, `test:e2e`, and any retained orchestration);
`npm run test:all` exits 0 byte-identical to the prior batch behavior;
CHANGELOG entry committed.

### B3 — c8 coverage instrumentation + `test:coverage` entry — DONE (B-c6cf, 2026-06-17)

**Scope:** add `c8` as a devDependency at root. Wrap the runner with
`c8 node packages/main/dist/tasks/run-all-smokes.js`. Add `npm run
test:coverage` script. Configure c8 to emit HTML report + LCOV under
`packages/main/coverage/`. Update `.gitignore` for `coverage/`. Document the
report in `docs/`.

**Acceptance:** `npm run test:coverage` runs every smoke under c8; HTML
coverage report opens at `packages/main/coverage/index.html`; LCOV file
generated at `packages/main/coverage/lcov.info`. CI integration is optional
(deferred to a separate story if/when CI is wired).

**Delivered (B-c6cf):** c8 v11 added to root devDependencies. `.c8rc.json` at
root configures `reporter: [text, html, lcov]`, `reports-dir:
packages/main/coverage`, include `packages/main/src/**/*.ts`, exclude
`dist`, `node_modules`, `*-smoke.ts` fixtures, and the runner itself.
`test:coverage` script: `c8 node packages/main/dist/tasks/run-all-smokes.js
--jobs 1` (single-process mode for v1 — child workers inherit
`NODE_V8_COVERAGE` from c8 and write per-process data that c8 merges).
`packages/main/coverage/` `.gitignore`'d. Usage doc at
`docs/dev/test-coverage.md`. CI integration remains deferred.

### B4 (optional) — Tag/select UX improvements

**Scope:** developer-ergonomics polish — watch mode (`--watch`), failure-only
re-run (`--rerun-failed`), JSON output mode (`--json`), `CONTRIBUTING.md`
documentation of the new entries. Optional because B1-B3 already deliver the
three stated benefits; B4 is incremental polish.

**Acceptance:** documented in `CONTRIBUTING.md`; each opt-in flag has a
positive test in the runner's own smoke (`run-all-smokes-smoke.ts`).

## Out of Scope (in this A0 decision story)

- Any runner code.
- Any smoke file edits.
- Any `package.json` script edits.
- Any c8 wiring.
- Any edits to existing decision docs (`testing-infra.md` and
  `testing-completeness.md` remain untouched).

## Closing

This decision document is not gate-consumed. It is a one-time architectural
commit. B1 should be the next story after B-35aa is DONE; B2 and B3 follow B1;
B4 is optional polish.
