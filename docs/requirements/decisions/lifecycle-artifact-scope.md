# Lifecycle Artifact Scope Policy

**Status**: active (B-b9d0)
**Scope**: scope-contract enforcement when a Koala command writes a story-scoped
metadata artifact during DEV / REVIEW / TEST / DONE.

## Why this exists

Koala lifecycle CLI commands (`delivery_check_set`, `summary_set`,
`scope_contract_set`, `finding_add`, `init_check_set`, …) write metadata files
under `.koala/story/actives/<storyId>/` or `docs/story/.../<storyId>/`. These
writes are not implementation work — they are command-generated provenance.
Before B-b9d0 the scope gate either failed-closed against them (blocking DONE)
or fell back to a blanket `.koala/` exemption that let arbitrary, unrelated
`.koala/foo.json` files pass.

This document fixes the policy in one place: lifecycle artifacts are a
**narrow, filename-aware, story-scoped, current-state classifier**. It is not
a substitute for evidence receipts and it does not weaken product source scope enforcement.

## The three classifier outputs

`packages/main/src/core/scope-contract.ts` evaluates each changed file in this
order:

1. **`classifyLifecycleArtifact(file, { storyId })`**
   – returns a hit only when the path matches:
   – a recognized story-dir prefix (`docs/story/actives/`,
     `.koala/story/actives/`, or a custom `storyDir`),
   – followed by a valid storyId segment,
   – followed by a terminal filename in `KOALA_LIFECYCLE_ARTIFACT_FILENAMES`
     (the closed set declared in `packages/main/src/core/lifecycle-registry.ts`).
   – Legacy story-tree paths under `docs/story/...` resolve as
     `legacy-metadata` for back-compat with PLAN-time files.

2. **`isRuntimeArtifactPath(file)`**
   – returns true for paths registered in the runtime-artifact registry:
     `.koala/activity.jsonl`, `.koala/runtime/...`, `.koala/traces/...`,
     `.koala/locks/...`, `owner-lease.json`, `docs/story/activity.jsonl`,
     `.koala-tmp-*`, `koala-debug.log`, `browser-test.log`, `.omx/...`, etc.
   – Used by scope to skip volatile runtime telemetry that Koala writes as a
     side-effect of read/write commands. **This is NOT a blanket `.koala/`
     pass.** An arbitrary file like `.koala/foo.json` does not match any
     registered runtime matcher and therefore falls through.

3. **fall-through** → normal `allowedModify` / `allowedCreate` /
   `allowedTest` / `protectedFiles` / `explicitExcludes` enforcement applies.
   This includes ordinary source files and any unrecognized JSON under
   `.koala/`.

## Adversarial invariant

Both reviewers and tests must continue to assert:

- a product source file (e.g. `packages/main/src/handlers/foo.ts`) that is not
  in the contract still fails scope when unacknowledged;
- an unknown `.koala/foo.json` not registered in the runtime registry and not
  matching the lifecycle filename set still fails scope when unacknowledged;
- removing or weakening rule (2) — for example reverting to
  `if (file.startsWith('.koala/')) continue;` — is a regression and must be
  flagged by the contract test.

> This classifier does not provide gate receipts. It tells you what a file is
> (provenance), not whether the corresponding gate (delivery-check, summary,
> review-pass, …) has been satisfied. Gate satisfaction lives in
> `done-oracle.ts` and the signed `*-check.json` artifacts. The classifier and
> the gates are independent — one cannot stand in for the other.

## Operational implications

- `delivery_check_set` and `summary_set` may freely write
  `.koala/story/actives/<id>/delivery-check.json` and `summary.json` during
  TEST without expanding scope or triggering an `OUT_OF_SCOPE` violation.
- `scope_contract_acknowledge` is still required for ordinary in-scope file
  expansions (product code, docs, new tests). It is **not** required for
  lifecycle artifacts.
- `scope_contract_acknowledge` is intentionally forbidden in TEST phase. The
  lifecycle-artifact classifier is the only legitimate path for command-
  generated artifact writes that arrive in TEST or later.
- `session_brief`'s TEST-phase next-step refuses to recommend DONE while the
  scope gate is blocking, so an out-of-scope diff cannot silently slip past a
  partial classifier match.

## Verification

Mechanical evidence lives in:

- `scripts/verify-process-fact-contract.mjs` — asserts the classifier accepts
  known lifecycle filenames under a story id, rejects arbitrary
  `.koala/foo.json`, and rejects ordinary product source files when scope is
  unacknowledged.
- `scripts/verify-gap-convergence.mjs` — asserts derived `.build` symlink
  loops do not crash `convergence_check` and do not hide real `docs/story` /
  truth-source content.
- `scripts/verify-session-brief-command-center.mjs` — asserts the TEST-phase
  next-step refuses DONE while scope is blocking and emits the blocking
  wording.

If any of these regress, the policy is broken and must be fixed before
landing further DEV work.
