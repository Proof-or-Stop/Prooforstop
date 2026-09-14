# Lifecycle Artifact Scope Policy

**Status**: active (B-b9d0; B-997b wave 1)
**Scope**: scope-contract enforcement when a Proof-or-Stop command writes a story-scoped
metadata artifact during DEV / REVIEW / TEST / DONE.

Retired pre-cutover path spellings are intentionally not named here as runnable
paths. They are rejected wherever this policy describes current lifecycle
classification.

## Why this exists

Proof-or-Stop lifecycle CLI commands (`delivery_check_set`, `summary_set`,
`scope_contract_set`, `finding_add`, `init_check_set`, …) write metadata files
under `.proof-or-stop/story/actives/<storyId>/` or `docs/story/.../<storyId>/`.
The retired hidden pre-cutover story tree is no longer a recognized story-dir prefix. These
writes are not implementation work — they are command-generated provenance.
Before B-b9d0 the scope gate either failed-closed against them (blocking DONE)
or fell back to a blanket retired-state-directory exemption that let arbitrary,
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

## The classifier outputs

`packages/main/src/core/scope-contract.ts` evaluates each changed file through
the shared classifier. Controller projection receipts use a stricter proof
before ordinary lifecycle filename classification:

1. **Controller projection receipt proof**
   – the canonical descriptors in
     `packages/main/src/core/managed-artifact-descriptors.ts` define the two
     exact Story receipt paths, their owner, producer, signature policy,
     projection policy, and tracked-file policy;
   – the runtime projection receipt is admitted only when its Story id,
     controller/worktree roots, Git common receipt, signature, exact hook set,
     digests, and controller/worktree bytes all match the current registered
     Story worktree;
   – a tracked, missing, malformed, stale, or tampered receipt fails closed as
     `UNTRUSTED_CONTROLLER_RUNTIME_PROJECTION_RECEIPT`. It is a framework repair,
     so the recovery path never asks the product Story to widen its scope.

2. **`classifyLifecycleArtifact(file, { storyId })`**
   – returns a hit only when the path matches:
   – a recognized story-dir prefix (`docs/story/actives/`,
     `.proof-or-stop/story/actives/`, or a custom `storyDir`;
     the retired hidden pre-cutover story tree is not recognized),
   – followed by a valid storyId segment,
   – followed by either a top-level terminal filename in
     `PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES` or a relative path in
     `PROOF_OR_STOP_LIFECYCLE_ARTIFACT_RELATIVE_PATHS` (the closed sets declared in
     `packages/main/src/core/lifecycle-registry.ts`).
     The relative-path set is intentionally closed. It includes registered
     transcript paths plus the controller config/runtime projection receipt
     paths derived from the canonical descriptors. It does not allow arbitrary files
     under `evidence/`, even when their basename is a known top-level lifecycle
     filename such as `summary.json`.
   – Legacy story-tree paths under `docs/story/...` resolve as
     `legacy-metadata` for back-compat with PLAN-time files.

3. **`isRuntimeArtifactPath(file)`**
   – returns true for paths registered in the runtime-artifact registry:
     `.proof-or-stop/activity.jsonl`, `.proof-or-stop/runtime/...`, `.proof-or-stop/traces/...`,
     `.proof-or-stop/locks/...`, `owner-lease.json`, `docs/story/activity.jsonl`,
     `.proof-or-stop-tmp-*`, `proof-or-stop-debug.log`,
     `browser-test.log`, etc.
   – Used by scope to skip volatile runtime telemetry that Proof-or-Stop writes as a
     side-effect of read/write commands. **This is NOT a blanket `.proof-or-stop/`
     pass.** An arbitrary file like `.proof-or-stop/foo.json` does not match any registered runtime matcher and
     therefore falls through.

4. **`classifySharedLifecycleMetadata(root, file)`**
   – recognizes only the canonical B-META `findings.json` and its separate
     `gap-log-provenance.jsonl` append ledger;
   – admits either path only when the complete HMAC receipt chain is contiguous,
     every receipt names the canonical `gap_log` writer/path, and the ledger
     head binds the current whole findings artifact;
   – rejects missing/reordered/edited receipts, public digest recomputation,
     symlink escape, direct findings edits, and a later `gap_log` attempt to
     launder altered history. The key is stored in the repository git common
     directory rather than the mutable story artifact. This is canonical-writer
     tamper evidence for cooperative local tooling, not an authorization
     boundary against an attacker who already controls the same OS account.
   – genesis is accepted only for a truly absent/canonically empty parent
     artifact. A committed non-empty legacy artifact must match the worktree
     semantically before its first receipt can extend it. Canonical findings or
     ledger symlinks are rejected even when they remain inside the repository
     and expose identical content.

5. **fall-through** → normal `allowedModify` / `allowedCreate` /
   `allowedTest` / `protectedFiles` / `explicitExcludes` enforcement applies.
   This includes ordinary source files and any unrecognized JSON under
   `.proof-or-stop/`.

## Adversarial invariant

Both reviewers and tests must continue to assert:

- a product source file (e.g. `packages/main/src/handlers/foo.ts`) that is not
  in the contract still fails scope when unacknowledged;
- an unknown `.proof-or-stop/foo.json` not registered in the runtime registry and not
  matching the lifecycle filename set still fails scope when unacknowledged;
- removing or weakening rule (3) — for example reverting to
  `if (file.startsWith('.proof-or-stop/')) continue;` — is a regression and must be
  flagged by the contract test.
- an arbitrary `.proof-or-stop/foo.json`, nested story evidence note, undeclared
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

- Global-thin project-level managed assets remain owned by the primary
  controller. A read-only `proof-or-stop check` invoked in a registered Story
  worktree inspects that controller. Mutating `check --apply` and
  `check --upgrade` are refused from the Story worktree with an exact
  controller-directory command, so a repair command cannot manufacture new
  out-of-scope Story files.

- `delivery_check_set` and `summary_set` may freely write
  `.proof-or-stop/story/actives/<id>/delivery-check.json` and `summary.json` during
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
  `.proof-or-stop/story/actives/<id>/evidence/transcript-diff.md` and
  `.proof-or-stop/story/actives/<id>/evidence/live-smoke-transcript.json` during TEST
  as lifecycle transcript artifacts. These exemptions are path-specific;
  sibling files such as `evidence/notes.md` and arbitrary nested evidence still
  fall through to normal scope enforcement.
- `scope_contract_acknowledge` is still required for ordinary in-scope file
  expansions (product code, docs, new tests). It is **not** required for
  lifecycle artifacts.
- Acknowledgement paths pass through the same repo/source-root canonicalizer as
  contract paths. Acknowledgement cannot be used as a raw-spelling bypass for
  traversal, ambiguity, protected files, or excluded files.
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
  files in the retired hidden pre-cutover tree and nearby non-transcript evidence
  files, includes the INIT scope anti-expansion artifact filenames, and rejects
  ordinary product source files when scope is unacknowledged.
- `packages/main/src/tasks/lifecycle-registry-contract.ts` — home of the
  runtime classification assertion (the acceptance-topology artifact filenames
  classify as `kind='lifecycle'` under an active story dir) and the StoryStore
  write-set coverage invariant: every top-level story artifact filename derived
  from `core/store.ts` must be registered in
  `PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES` or listed in a named exemption
  constant (registered-or-exempted, named divergence per missing filename).
- `packages/main/src/tasks/gap-log-smoke.ts` — asserts the independent B-META
  receipt chain, current-artifact binding, public-forgery rejection, and
  fail-closed refusal to extend an altered history.
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

Proof-or-Stop init supports two compatible prompt asset shapes:

| Layer | Examples | Ownership |
| --- | --- | --- |
| project-local required assets | Default fresh init primary (global-thin): `.proof-or-stop/Proof-or-Stop.md`, `.proof-or-stop/proof-or-stop.json`, `AGENTS.md`. Full/local-shim explicit opt-in (`--asset-mode=full`/`--asset-mode=thin`): `PROOF_OR_STOP.md`, `.proof-or-stop-codex/proof-or-stop.json`, `bin/proof-or-stop.js`, `bin/proof-or-stop-codex.js`, `.claude/settings.json`, `.claude/hooks/*`. | Repository-local host entrypoints, adapter config, and command launchers. Global-thin init requires only `.proof-or-stop/` assets; local wrappers are generated only in full/thin modes. |
| package registry prompt templates | `packages/main/templates/agents/*.md` exposed through the versioned prompt-registry schema | Versioned Proof-or-Stop package assets. These are the canonical prompt bodies. |
| generated or materialized prompt caches | `.proof-or-stop-codex/agents/*.md`, `.claude/agents/*.md` when a profile asks for full materialization | Compatibility surfaces for hosts or old repositories that still expect local prompt files. |

The phrase **registry-backed prompt assets** means project metadata points at the
package prompt registry instead of treating every rendered agent prompt as a
project-local required file. In global-thin mode (the default for new projects),
`.proof-or-stop/proof-or-stop.json` carries the project config and asset mode declaration,
and Codex adapter verification resolves the `.proof-or-stop/` manifest rather than
requiring `.proof-or-stop-codex/` entries or local bin wrappers. In full/thin modes,
`.proof-or-stop-codex/proof-or-stop.json` carries the prompt registry version and material hash.
Retired adapter manifests may remain archived or user-owned, but they are not
active adapter inputs.

The Proof-or-Stop naming migration is a managed-asset naming contract only. It does
not promote ordinary CLI output to receipt-backed authority and does not change
Story lifecycle gates. `proof-or-stop` is the primary active runtime/product
command. Retired command spellings do not resolve as aliases; scripts and
in-flight stories must use the canonical command.
Fresh init must not generate retired top-level guidance, adapter manifests, or
wrapper names; compatibility checks do not treat those paths as active
adapter or runtime inputs. Cleanup may remove a legacy-named asset only
when its content exactly matches a generated template or manifest; user-owned
legacy files are preserved.

This is a **legacy mirror compatibility** change, not a host behavior removal.
Legacy full-mode repositories may keep `.proof-or-stop-codex/agents` and `.claude/agents`.
Thin-mode repositories may omit `.proof-or-stop-codex/agents` when the manifest selects
registry prompts. Claude Code host-local discovery can still use materialized
`.claude/agents` where that host profile requires it.

Safe migration follows the existing managed-asset states:

- `OK` registry manifests and full-mode mirrors are both valid.
- `MISSING` registry metadata can be created by explicit thin init/check flows.
- `STALE_SAFE` generated prompt mirrors may be updated or removed only when
  Proof-or-Stop can prove they are old unedited managed assets.
- `STALE_LOCAL_EDIT`, `CASE_MISMATCH`, and `INCOMPATIBLE` prompt files are
  report-only. Proof-or-Stop must not overwrite or delete local edits during thin
  migration.

Registry-backed prompt checks are adapter hygiene. They do not submit evidence,
verify receipts, or satisfy production authority. Validation evidence and
receipt-backed authority remain separate gate inputs.

## Policy: host-neutral prompt content, thin host adapters (B-097f)

The package prompt registry (`packages/main/templates/agents/*.md` via
`promptRegistryManifest()`) is the single source for ordinary role bodies and
for the six migrated reviewer definitions. The registry host resolver exposes
the five active REVIEW lanes as a body-free bootstrap; `review_run_start`
selects and returns exactly one legacy or modular role body for those lanes.
Topology-critic stays a modular body and is not a REVIEW-lane bootstrap.
Each host keeps only a *thin adapter* or that canonical bootstrap. The adapter
shape is dictated by the host's loader, but the selected-body source remains
the package registry.

| Host | Thin adapter (what lives in the project/global) | Prompt content source |
| --- | --- | --- |
| Codex | `.proof-or-stop-codex/proof-or-stop.json` manifest (`promptMode: 'registry'`) — B-4ee0 | package registry host render: reviewer bootstrap or ordinary role body |
| Claude | `.claude/agents/*.md` **thin shim/bootstrap** (frontmatter `name`/`description`/`tools` + a CLI pointer) | migrated reviewers use `review_run_start`; ordinary roles use `proof-or-stop agent_prompt` |

B-4ee0 already collapsed the **Codex** side: in global-thin/thin mode Codex does
not materialize `.proof-or-stop-codex/agents`; it resolves prompts from the registry via its
manifest. This policy does the host-neutral equivalent for **Claude**, which —
unlike Codex — cannot resolve a subagent from a single manifest: Claude Code only
discovers subagents from on-disk `.claude/agents/*.md` files and reads each file's
frontmatter to register the `subagent_type` and its `tools` sandbox. So Claude
keeps one file per role, but that file is a **content-free shim**.

**Contract:**

1. **Selected reviewer role content never lives under a host.** A migrated
   reviewer bootstrap contains only
   frontmatter (`name`, `description`, `tools`) plus a body instructing the agent
   to call `review_run_start`; that command returns the single selected role
   body. Ordinary roles retain their `agent_prompt` shim contract. No migrated
   reviewer role body is copied or symlinked into a host directory.

2. **The registry host render is the shared bootstrap/body endpoint.**
   `proof-or-stop agent_prompt --role=<name>` returns the canonical registry host
   render: a body-free `review_run_start` bootstrap for the five active REVIEW
   lanes among the six migrated reviewer definitions, and the canonical role
   body for ordinary roles including topology-critic. Codex registry
   mode resolves the same host render. For the five active REVIEW lanes,
   `review_run_start` alone supplies exactly one selected role body.

   `review_run_start` and Story-aware `agent_prompt` share one bakery-style
   unique-ticket transaction lock for Prompt Envelope metadata; the review-run
   path nests no fixed-path envelope lock. Each acquisition owns a never-reused
   UUID path; stale recovery deletes only that exact dead ticket. This is
   gate-consumed evidence behavior: two reclaimers cannot delete a replacement
   holder through fixed-path ABA, overlap the two producers, and lose a reviewer
   lane.

3. **Shims live in global `~/.claude/agents`; projects get zero agent files.** The
   16 shims are generated once into the user-global `~/.claude/agents` so Claude
   Code resolves `subagent_type: proof-or-stop-*` for all projects from one place.
   `proof-or-stop init` writes **zero** `.claude/agents` files into a project (fresh
   tree stays `.proof-or-stop/Proof-or-Stop.md` + `AGENTS.md`, plus any pre-existing
   `CLAUDE.md`). Shim frontmatter (`tools`) is derived from each registry
   template's frontmatter so the reviewer read-only sandbox is preserved.

4. **`tools` sandbox is preserved.** Because the shim keeps the `tools:`
   frontmatter, the host still mechanically restricts each role (e.g.
   `proof-or-stop-review-*` stay read-only). Thinning the body does not weaken the
   sandbox.

5. **Migration is explicit, never silent (execution-plan Phase 4).** A normal
   `proof-or-stop init` MUST NOT delete project-local files. When it detects existing
   project-local managed agent files (full copies or symlinks from older
   versions) it only WARNs and points at `proof-or-stop init --upgrade`. Removal happens
   only under the explicit `--upgrade` flow, deletes only the managed basenames
   (the set from `templates/agents`), preserves user-authored files, forbids
   wildcard clears, and logs each removal.

6. **Precedence drives why removal is required.** Claude Code project-level
   `.claude/agents/` shadows user-level `~/.claude/agents/` (project wins on name
   collision). Stale project-local managed files must be removed under `--upgrade`
   for the global shims to take effect.

7. **Observability.** `proof-or-stop doctor` reports `agentAssetMode: runtime-owned` so
   the host-neutral state is diagnosable across projects.

This realizes the runtime-owned principle in
the runtime-owned agent assets execution plan for both hosts: agent
prompt **content** belongs to the local Proof-or-Stop CLI runtime/registry, not to any
host directory or business project; hosts hold only thin, content-free adapters.
