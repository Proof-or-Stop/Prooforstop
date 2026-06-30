# Lifecycle Artifact Scope Policy

**Status**: active (B-b9d0; B-997b wave 1)
**Scope**: scope-contract enforcement when a Proofbound command writes a story-scoped
metadata artifact during DEV / REVIEW / TEST / DONE.

Legacy Proofbound path note: the old hidden Proofbound story tree is intentionally not
named here as a runnable path. It is retired and rejected wherever this policy
describes current lifecycle classification.

## Why this exists

Proofbound lifecycle CLI commands (`delivery_check_set`, `summary_set`,
`scope_contract_set`, `finding_add`, `init_check_set`, …) write metadata files
under `.lattice/story/actives/<storyId>/` or `docs/story/.../<storyId>/`.
The retired hidden Proofbound story tree is no longer a recognized story-dir prefix. These
writes are not implementation work — they are command-generated provenance.
Before B-b9d0 the scope gate either failed-closed against them (blocking DONE)
or fell back to a blanket legacy Lattice-directory exemption that let arbitrary,
unrelated files in that retired tree pass.

This document fixes the policy in one place: lifecycle artifacts are a
**narrow, filename-aware, story-scoped, current-state classifier**. It is not
a substitute for evidence receipts and it does not weaken product source scope enforcement.

B-e781 closes the B-43de M4-M12 parent roadmap rows with local machine evidence
and row-level claim boundaries. The B-997b shipped scope behavior still covers
canonical changed-file rows, lifecycle/runtime artifact classification, guard
projection, and acknowledgement visibility. It does not claim retired Authority
Server production/runtime conformance, Authority receipts, Layer 4 production
proof, customer key behavior, baseline unlocks, renderer/scheduler work, or
unrelated runtime features.

## The three classifier outputs

`packages/main/src/core/scope-contract.ts` evaluates each changed file in this
order:

1. **`classifyLifecycleArtifact(file, { storyId })`**
   – returns a hit only when the path matches:
   – a recognized story-dir prefix (`docs/story/actives/`,
     `.lattice/story/actives/`, or a custom `storyDir`;
     the retired hidden Proofbound story tree is not recognized),
   – followed by a valid storyId segment,
   – followed by either a top-level terminal filename in
     `LATTICE_LIFECYCLE_ARTIFACT_FILENAMES` or a relative path in
     `LATTICE_LIFECYCLE_ARTIFACT_RELATIVE_PATHS` (the closed sets declared in
     `packages/main/src/core/lifecycle-registry.ts`).
     The relative-path set is intentionally tiny: today it includes only the
     TEST transcript evidence paths `evidence/transcript-diff.md` and
     `evidence/live-smoke-transcript.json`. It does not allow arbitrary files
     under `evidence/`, even when their basename is a known top-level lifecycle
     filename such as `summary.json`.
   – Legacy story-tree paths under `docs/story/...` resolve as
     `legacy-metadata` for back-compat with PLAN-time files.

2. **`isRuntimeArtifactPath(file)`**
   – returns true for paths registered in the runtime-artifact registry:
     `.lattice/activity.jsonl`, `.lattice/runtime/...`, `.lattice/traces/...`,
     `.lattice/locks/...`, `owner-lease.json`, `docs/story/activity.jsonl`,
     `.lattice-tmp-*`, `lattice-debug.log`,
     `browser-test.log`, etc.
   – Used by scope to skip volatile runtime telemetry that Proofbound writes as a
     side-effect of read/write commands. **This is NOT a blanket `.lattice/`
     pass.** An arbitrary file like `.lattice/foo.json` does not match any registered runtime matcher and
     therefore falls through.

3. **fall-through** → normal `allowedModify` / `allowedCreate` /
   `allowedTest` / `protectedFiles` / `explicitExcludes` enforcement applies.
   This includes ordinary source files and any unrecognized JSON under
   `.lattice/`.

## Adversarial invariant

Both reviewers and tests must continue to assert:

- a product source file (e.g. `packages/main/src/handlers/foo.ts`) that is not
  in the contract still fails scope when unacknowledged;
- an unknown `.lattice/foo.json` not registered in the runtime registry and not
  matching the lifecycle filename set still fails scope when unacknowledged;
- removing or weakening rule (2) — for example reverting to
  `if (file.startsWith('.lattice/')) continue;` — is a regression and must be
  flagged by the contract test.
- an arbitrary `.lattice/foo.json`, nested story evidence note, undeclared
  source file, direct story JSON edit, or direct fixture edit still fails closed
  unless a story's explicit scope and phase policy permits it through the
  supported CLI path.

## Stable scope rows

Scope classification now produces stable rows for operator renderers and tests.
The row is explanation and enforcement input; it is not a receipt for summary,
delivery, review, validation, or DONE.

Expected row families:

| Path kind | Example row id | Status | Blocking | Meaning |
|---|---|---|---|---|
| Registered lifecycle artifact | `scope.lifecycle_artifact:B-scope:summary.json` | `pass` | `false` | The file is command-generated story provenance. The summary gate still needs its own structured summary evidence. |
| Registered runtime artifact | `scope.runtime_artifact:<registry-id>` | `pass` | `false` | The file matched `runtime-artifact-registry.ts`; this is not a blanket directory exemption. |
| Undeclared material/source/fixture/story path | `scope.out_of_scope:<path>` | `fail` | `true` | The path falls through to normal scope enforcement and needs PLAN scope declaration, rollback, or a valid acknowledgement path. |
| Acknowledged DEV/REVIEW expansion | `scope.out_of_scope:<path>` | `warn` | `false` | The acknowledged expansion remains warn and reviewer-visible; it is not silently promoted to a normal pass. |

> This classifier does not provide gate receipts. It tells you what a file is
> (provenance), not whether the corresponding gate (delivery-check, summary,
> review-pass, …) has been satisfied. Gate satisfaction lives in
> `done-oracle.ts` and the signed `*-check.json` artifacts. The classifier and
> the gates are independent — one cannot stand in for the other.

## Operational implications

- `delivery_check_set` and `summary_set` may freely write
  `.lattice/story/actives/<id>/delivery-check.json` and `summary.json` during
  TEST without expanding scope or triggering an `OUT_OF_SCOPE` violation.
- INIT scope anti-expansion commands may write `scope-boundary.json`,
  `execution-boundary.json`, `scope-freeze-check.json`,
  and `scope-extension-proposals.json` as lifecycle artifacts. `story_discard`
  produces `scope-discard-digest.json` for the discarded story; the
  INIT_CHECK/scope freeze gate consumes the current story's discard digest plus
  digest entries from every story currently in `DISCARDED` phase. Classification only
  recognizes these filenames as provenance; INIT_CHECK gate satisfaction still
  requires the machine guard to verify hashes, freshness, pending proposal
  state, excluded keyword hits, and repeat-discard mitigation.
- User-value acceptance transcript commands may write
  `.lattice/story/actives/<id>/evidence/transcript-diff.md` and
  `.lattice/story/actives/<id>/evidence/live-smoke-transcript.json` during TEST
  as lifecycle transcript artifacts. These exemptions are path-specific;
  sibling files such as `evidence/notes.md` and arbitrary nested evidence still
  fall through to normal scope enforcement.
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
  known lifecycle filenames plus `evidence/transcript-diff.md` and
  `evidence/live-smoke-transcript.json` under a story id, rejects arbitrary
  files in the retired hidden Proofbound tree and nearby non-transcript evidence
  files, includes the INIT scope anti-expansion artifact filenames, and rejects
  ordinary product source files when scope is unacknowledged.
- `scripts/verify-gap-convergence.mjs` — asserts derived `.build` symlink
  loops do not crash `convergence_check` and do not hide real `docs/story` /
  truth-source content.
- `scripts/verify-session-brief-command-center.mjs` — asserts the TEST-phase
  next-step refuses DONE while scope is blocking and emits the blocking
  wording.

If any of these regress, the policy is broken and must be fixed before
landing further DEV work.

## Policy: test-evidence.json is gate-consumed validation metadata

test-evidence.json is gate-consumed validation metadata, not material drift input. PASS/FAIL/coverage still feed gates, and real source or evidence drift remains stale. Changes to test-evidence.json alone do not invalidate prior material-hash evidence.

## Policy: registry-backed prompt assets

Proofbound init supports two compatible prompt asset shapes:

| Layer | Examples | Ownership |
| --- | --- | --- |
| project-local required assets | Default fresh init primary (global-thin): `.lattice/Lattice.md`, `.lattice/lattice.json`, `AGENTS.md`. Full/local-shim explicit opt-in (`--asset-mode=full`/`--asset-mode=thin`): `LATTICE.md`, `.lattice-codex/lattice.json`, `bin/lattice.js`, `bin/lattice-codex.js`, `.claude/settings.json`, `.claude/hooks/*`. | Repository-local host entrypoints, adapter config, and command launchers. Global-thin init requires only `.lattice/` assets; local wrappers are generated only in full/thin modes. |
| package registry prompt templates | `packages/main/templates/agents/*.md` exposed through `lattice.prompt-registry.v1` | Versioned Proofbound package assets. These are the canonical prompt bodies. |
| generated or materialized prompt caches | `.lattice-codex/agents/*.md`, `.claude/agents/*.md` when a profile asks for full materialization | Compatibility surfaces for hosts or old repositories that still expect local prompt files. |

The phrase **registry-backed prompt assets** means project metadata points at the
package prompt registry instead of treating every rendered agent prompt as a
project-local required file. In global-thin mode (the default for new projects),
`.lattice/lattice.json` carries the project config and asset mode declaration,
and Codex adapter verification resolves the `.lattice/` manifest rather than
requiring `.lattice-codex/` entries or local bin wrappers. In full/thin modes,
`.lattice-codex/lattice.json` carries the prompt registry version and material hash.
Legacy `.lattice-codex/lattice.json` files may remain archived or user-owned, but they are
not active adapter inputs.

The Proofbound naming migration is a managed-asset naming contract only. It does
not promote ordinary CLI output to receipt-backed authority and does not change
Story lifecycle gates. `lattice` is the only active runtime/product command.
Fresh init must not generate `LATTICE.md`, `.lattice-codex/lattice.json`, `bin/lattice.js`, or
`bin/lattice-codex.js`; compatibility checks do not treat those paths as active
adapter or runtime inputs. Cleanup may remove a legacy-named asset only
when its content exactly matches a generated template or manifest; user-owned
legacy files are preserved.

This is a **legacy mirror compatibility** change, not a host behavior removal.
Legacy full-mode repositories may keep `.lattice-codex/agents` and `.claude/agents`.
Thin-mode repositories may omit `.lattice-codex/agents` when the manifest selects
registry prompts. Claude Code host-local discovery can still use materialized
`.claude/agents` where that host profile requires it.

Safe migration follows the existing managed-asset states:

- `OK` registry manifests and full-mode mirrors are both valid.
- `MISSING` registry metadata can be created by explicit thin init/check flows.
- `STALE_SAFE` generated prompt mirrors may be updated or removed only when
  Proofbound can prove they are old unedited managed assets.
- `STALE_LOCAL_EDIT`, `CASE_MISMATCH`, and `INCOMPATIBLE` prompt files are
  report-only. Proofbound must not overwrite or delete local edits during thin
  migration.

Registry-backed prompt checks are adapter hygiene. They do not submit evidence,
verify receipts, or satisfy production authority. Validation evidence and
receipt-backed authority remain separate gate inputs.

## Policy: host-neutral prompt content, thin host adapters (B-097f)

The single source of truth for every Proofbound agent prompt **body** is the package
prompt registry (`packages/main/templates/agents/*.md` via
`promptRegistryManifest()`). **No host materializes prompt content.** Each host
keeps only a *thin adapter* that points back at the registry; the adapter shape is
dictated by that host's loader, but the content source is identical across hosts.

| Host | Thin adapter (what lives in the project/global) | Prompt content source |
| --- | --- | --- |
| Codex | `.lattice-codex/lattice.json` manifest (`promptMode: 'registry'`) — B-4ee0 | package prompt registry |
| Claude | `.claude/agents/*.md` **thin shim** (frontmatter `name`/`description`/`tools` + a "fetch from CLI" body) | package prompt registry, served by `lattice agent_prompt` |

B-4ee0 already collapsed the **Codex** side: in global-thin/thin mode Codex does
not materialize `.lattice-codex/agents`; it resolves prompts from the registry via its
manifest. This policy does the host-neutral equivalent for **Claude**, which —
unlike Codex — cannot resolve a subagent from a single manifest: Claude Code only
discovers subagents from on-disk `.claude/agents/*.md` files and reads each file's
frontmatter to register the `subagent_type` and its `tools` sandbox. So Claude
keeps one file per role, but that file is a **content-free shim**.

**Contract:**

1. **Prompt content never lives under a host.** A Claude shim contains only
   frontmatter (`name`, `description`, `tools`) plus a body instructing the agent
   to fetch its authoritative instructions from the Proofbound CLI. The role prompt
   body is **not** copied or symlinked into any host directory.

2. **`lattice agent_prompt --role=<name>` is the shared content endpoint.** It
   returns the canonical role body by reading the package registry template
   (`templates/agents/<role>.md`) — the same template set the prompt registry
   manifest (`promptRegistryManifest()`) is built from and that the Codex manifest
   resolves against. Claude shims fetch from this command; Codex resolves the same
   template set. There is one content source, byte-for-byte.

3. **Shims live in global `~/.claude/agents`; projects get zero agent files.** The
   16 shims are generated once into the user-global `~/.claude/agents` so Claude
   Code resolves `subagent_type: lattice-*` for all projects from one place.
   `lattice init` writes **zero** `.claude/agents` files into a project (fresh
   tree stays `.lattice/Lattice.md` + `AGENTS.md`, plus any pre-existing
   `CLAUDE.md`). Shim frontmatter (`tools`) is derived from each registry
   template's frontmatter so the reviewer read-only sandbox is preserved.

4. **`tools` sandbox is preserved.** Because the shim keeps the `tools:`
   frontmatter, the host still mechanically restricts each role (e.g.
   `lattice-review-*` stay read-only). Thinning the body does not weaken the
   sandbox.

5. **Migration is explicit, never silent (execution-plan Phase 4).** A normal
   `lattice init` MUST NOT delete project-local files. When it detects existing
   project-local managed agent files (full copies or symlinks from older
   versions) it only WARNs and points at `lattice init --upgrade`. Removal happens
   only under the explicit `--upgrade` flow, deletes only the managed basenames
   (the set from `templates/agents`), preserves user-authored files, forbids
   wildcard clears, and logs each removal.

6. **Precedence drives why removal is required.** Claude Code project-level
   `.claude/agents/` shadows user-level `~/.claude/agents/` (project wins on name
   collision). Stale project-local managed files must be removed under `--upgrade`
   for the global shims to take effect.

7. **Observability.** `lattice doctor` reports `agentAssetMode: runtime-owned` so
   the host-neutral state is diagnosable across projects.

This realizes the runtime-owned principle in
`lattice-runtime-owned-agent-assets-execution-plan.md` for both hosts: agent
prompt **content** belongs to the local Proofbound CLI runtime/registry, not to any
host directory or business project; hosts hold only thin, content-free adapters.
