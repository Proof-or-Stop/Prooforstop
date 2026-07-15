# Proof-or-stop Thin Entrypoint Contract Migration Execution Plan

## Status

- Status: active implementation plan; migration not yet implemented.
- Scope: migrate the repository from a Claude-first root-document contract to host-neutral thin entrypoints backed by canonical documentation and mechanical registries.
- Product boundary: this plan changes documentation authority, generated assets, discovery, audit, review routing, and verification. It does not change the Story lifecycle, reviewer quorum, evidence admissibility, or DONE semantics.
- Delivery boundary: this document and its navigation entry are the only product changes in story B-c1f1. Every implementation stage below requires its own Story, verification evidence, review, and rollback point.
- Brand and host vocabulary: use `Proof-or-stop`; the three current hosts are Codex CLI, Claude Code CLI, and Antigravity CLI (`agy`). Do not introduce `CODEX.md`, `AGY.md`, or legacy Gemini CLI terminology as new contracts.

## Problem Statement

The repository already intends `AGENTS.md` and `CLAUDE.md` to be small discovery entrypoints, but current runtime and verification code still treats root `CLAUDE.md`—and in some checks root `AGENTS.md`—as a complete process contract. Making the files thin without migrating those consumers breaks audits, docs-drift checks, reviewer prompts, transition hints, and `npm test`. Copying the lifecycle back into both files would restore tests at the cost of preserving the architectural defect.

The migration must therefore change the authority graph and its mechanical consumers before declaring the old contract retired. Moving Markdown alone is insufficient.

## Decisions

### Host discovery matrix

| Host | Automatically discovered root entrypoint | Shared rules | Host-specific assets | Explicit non-contracts |
|---|---|---|---|---|
| Codex CLI | `AGENTS.md` | Reads the shared project constraints and canonical navigation from `AGENTS.md` | `.lattice-codex/` | No `CODEX.md` |
| Claude Code CLI | `CLAUDE.md` | `CLAUDE.md` imports or otherwise delegates shared rules to `AGENTS.md`; it must not copy the shared body | `.claude/agents/`, `.claude/hooks/`, `.claude/settings.json`, and supported Claude profiles | No second full lifecycle contract in `CLAUDE.md` |
| Antigravity CLI (`agy`) | `AGENTS.md` | Uses the same shared project entrypoint as Codex CLI | `.agents/` only when Antigravity-specific material is actually required | No `AGY.md`; do not add `GEMINI.md` without a separately proven compatibility requirement |

`AGENTS.md` is a shared convention entrypoint, not a Codex-only document. `CLAUDE.md` remains because its filename is a Claude Code discovery contract, not because Claude owns the common process contract.

### Target hierarchy and precedence

```text
AGENTS.md
  ├─ repository-local, non-negotiable constraints
  └─ → .lattice/Lattice.md

CLAUDE.md
  ├─ import/delegate → AGENTS.md
  ├─ Claude Code-only adapter information
  └─ → .lattice/Lattice.md

.lattice/Lattice.md
  ├─ host-neutral Proof-or-stop navigation
  ├─ → docs/dev/lattice-agent-runbook.md
  └─ → normative decision documents

docs/dev/lattice-agent-runbook.md
  ├─ operational projection: recovery, standard commands, review order,
  │  TEST-to-DONE convergence, and diagnosis
  └─ → docs/requirements/decisions/*.md

docs/requirements/decisions/*.md
  └─ normative process intent and policy

CLI registries, handlers, and gates
  └─ executable and mechanically consumed runtime facts
```

The existing `.lattice/Lattice.md` path is preserved. It is the one host-neutral navigation entry, but it is not a third copy of lifecycle prose.

When sources disagree, apply this order:

1. Current user and platform instructions govern the active interaction.
2. CLI schemas, registries, handlers, and gates govern executable runtime behavior and admissible evidence.
3. `docs/requirements/decisions/` governs normative process intent.
4. `docs/dev/lattice-agent-runbook.md` is a mechanically checked operational projection of those facts.
5. `.lattice/Lattice.md`, `AGENTS.md`, and `CLAUDE.md` provide discovery, minimum local constraints, and navigation; they do not redefine the detailed process.

A conflict between layers is a drift defect to fix, not permission to select whichever text is convenient.

### Normative facts versus operational projection

The runbook may explain how to resume a session, execute the standard Story flow, order reviewer work, converge TEST to DONE, diagnose a blocker, and invoke common CLI commands. Those instructions are behavior-affecting projections, so they must be checked against the command, lifecycle, reviewer-lane, and DONE-policy registries. The runbook must link to the owning decision for every process section and must state that decision docs and mechanical gates prevail if drift is detected.

Detailed lifecycle, verification, review-assurance, convergence, drift, and ownership facts remain in their existing decision sources, including:

- `docs/requirements/decisions/story-lifecycle.md`
- `docs/requirements/decisions/testing-infra.md`
- `docs/requirements/decisions/done-prepare-automation-execution-plan.md`
- `docs/requirements/decisions/review-assurance-floor-execution-plan.md`
- `docs/requirements/decisions/session-ownership-and-write-leases.md`
- `docs/requirements/decisions/story-files-hash-material-drift.md`

The runbook summarizes operations and links to these sources; it must not become co-equal normative authority.

### Root entrypoint content and budgets

`AGENTS.md` directly retains only the constraints that must be visible before following a link:

- `lattice session_brief` is the first command in a new or resumed session.
- User instructions override repository defaults.
- Story and fixture stores are not edited directly; use the Lattice CLI.
- Work follows the Story lifecycle unless the user explicitly requests an allowed quick path.
- Engineering completion is not the same as user-value completion.
- Ownership, lock, destructive-command, and blind-retry prohibitions that are needed before any action.
- Links to `.lattice/Lattice.md`, the runbook, and the normative documentation index.
- A statement that CLI output and gates are mechanical facts while the root file provides discovery and minimum safety constraints.

`CLAUDE.md` retains only:

- Claude Code discovery and shared-rule import/delegation.
- Claude-specific agent, hook, settings, and profile locations.
- Links to the same host-neutral guide and runbook.
- A statement that shared rules come from `AGENTS.md` and canonical documents.

The following are excluded from both managed root bodies: full CLI references, complete phase chapters, Finding schemas, checklist example collections, DONE drift taxonomies, reviewer/subagent manuals, and historical compatibility essays.

Budgets are anti-regression ceilings, not fill targets:

| Asset | Recommended generated/managed size | Hard ceiling | Hard byte ceiling |
|---|---:|---:|---:|
| `AGENTS.md` managed body | 30–60 lines | 150 lines | 16 KiB |
| `CLAUDE.md` managed body | 10–30 lines | 120 lines | 12 KiB |

Verification must measure the managed body separately from user-owned text. It must also resolve the effective import closure for each host, deduplicate repeated imports, reject cycles, and cap the resolved shared instruction closure at 220 lines and 24 KiB. A short file that imports an unbounded or cyclic body does not satisfy the thin-entrypoint contract.

All local Markdown links in the managed bodies, `.lattice/Lattice.md`, and the runbook must resolve to an existing file and anchor, must not target retired authority, and must not form a navigation/import cycle.

### Repository-local constraints and managed ownership

The OMX prohibition, user-owned bootstrap text, and other repository-local constraints remain outside the Proof-or-stop managed block unless they are separately adopted as universal generated policy. In this repository, the OMX prohibition must remain directly visible in `AGENTS.md`, but generators must not propagate it to unrelated projects.

Managed-asset updates must preserve text before and after `<!-- lattice:start -->` / `<!-- lattice:end -->`. Tests must prove that profile changes, init, check, and repair do not delete, duplicate, or relocate repository-local text. Claude's import/delegation must expose the shared repository-local constraints without copying them into a second managed body.

## Shared Canonical-Document Registry

Create one typed, data-only registry—for example `packages/main/src/core/canonical-agent-docs.ts`—and make all behavior-affecting consumers use it instead of maintaining path arrays independently. A suitable shape is:

```ts
type CanonicalAgentDocRole =
  | 'shared-entrypoint'
  | 'host-entrypoint'
  | 'host-neutral-guide'
  | 'operational-projection'
  | 'normative-process';

interface CanonicalAgentDoc {
  path: string;
  role: CanonicalAgentDocRole;
  hosts: Array<'codex' | 'claude' | 'antigravity'>;
  auditCommands: boolean;
  auditPaths: boolean;
  docsDrift: boolean;
  reviewDiscoverable: boolean;
  required: boolean;
  legacyFallback?: boolean;
}
```

The initial registry contains `AGENTS.md`, `CLAUDE.md`, `.lattice/Lattice.md`, `docs/dev/lattice-agent-runbook.md`, and the specifically owned decision documents. Selectors such as `docsForMechanicalAudit()`, `docsForReviewDrift()`, `docsForHost(host)`, and `normativeDocsForFact(fact)` return ordered, deduplicated paths. The registry contains no filesystem I/O; callers resolve paths from the repository or git root appropriate to their gate.

The process-fact verifier must use the same exported ownership model or a generated JSON projection of it. It must not keep a second handwritten list that again requires lifecycle vocabulary in root entrypoints.

### Source-independent semantic fact identity

Dual-read deduplication must not include path, anchor, or document role in fact identity, because canonical and legacy sources necessarily have different locations. Each scanner normalizes a behavior-affecting statement into:

```ts
interface NormalizedDocFact {
  factType: 'command' | 'flag' | 'path' | 'lifecycle' | 'review' | 'evidence' | 'policy';
  subject: string;             // normalized entity affected by the fact
  commandOrPolicy: string;     // normalized CLI command or stable policy key
  semantics: {
    modality: 'must' | 'must-not' | 'may' | 'advisory';
    predicate: string;         // canonical whitespace/case/parameter representation
    outcome: string;           // normalized required, forbidden, or reported result
    parameters: string[];      // sorted, normalized flags/fields when applicable
  };
}

interface FactProvenance {
  path: string;
  anchor: string | null;
  role: CanonicalAgentDocRole | 'legacy-fallback';
  host: 'codex' | 'claude' | 'antigravity' | 'shared';
  rawTextHash: string;
}
```

Normalize Unicode, line endings, whitespace, command spelling, flag ordering, parameter placeholders, and registry-backed aliases before serializing with canonical JSON key order. Compute:

```text
conflictKey = SHA-256(canonicalJson({ factType, subject, commandOrPolicy }))
fingerprint = SHA-256(canonicalJson({ factType, subject, commandOrPolicy, semantics }))
```

`fingerprint` is the source-independent semantic identity. Equal fingerprints with byte-identical canonical payloads merge into one fact whose provenance is the ordered union of every source path, anchor, role, host, and raw-text hash. Source information is never discarded and never participates in identity.

Fail closed in either conflict case:

1. Equal `conflictKey` with different normalized `semantics` means canonical and legacy sources disagree about the same subject/policy. Record a semantic-conflict result containing both fingerprints and all provenance; audit, readiness, and retirement fail until the owning source is corrected.
2. Equal `fingerprint` with non-identical canonical payload bytes means a hash collision or normalizer defect. Record a fingerprint-collision result and fail without choosing either payload.

Readiness and retirement compare semantic sets, not document locations. A fingerprint with legacy provenance and no canonical provenance is a legacy-only fact and blocks readiness. A fingerprint present in both sources counts once and retains both provenance records. Any conflict/collision blocks readiness and retirement. Retirement is allowed only when every retained behavior fact has canonical provenance, the legacy-only set is empty, and the conflict/collision set is empty; moving a fact between canonical paths does not reset semantic identity.

Required dual-read fixtures:

| Fixture | Expected result |
|---|---|
| Canonical runbook and legacy `CLAUDE.md` express the same normalized command/policy fact with different wording and paths | One fingerprint, one fact, and exactly two provenance sources; readiness does not count it as legacy-only |
| Legacy `CLAUDE.md` contains a normalized fact absent from all canonical sources | One legacy-only fingerprint with its provenance; readiness and retirement fail and identify the missing canonical owner |
| Two payloads share a `conflictKey` but have opposing semantics, plus an injected same-hash/different-payload collision fixture | Semantic conflict and fingerprint collision are separately reported; both fail closed and neither source is selected as authoritative |

## Current Consumer Inventory

Before each implementation Story, produce a fresh, repository-wide bounded scan manifest. A preselected `rg` over known files is not sufficient. The scan must enumerate tracked text files under the root entrypoints, `.lattice/`, `docs/`, `packages/main/src/`, `packages/main/templates/`, and `scripts/`; exclude generated output, Story stores, fixture stores, dependencies, worktrees, and disabled legacy areas; then search both code-shaped and prose-shaped authority references. At minimum it must detect:

- exact paths and filename literals for `CLAUDE.md`, `AGENTS.md`, `LATTICE.md`, and `.lattice/Lattice.md`;
- path arrays, `readFile`/`existsSync` calls, git pathspecs, glob patterns, managed-asset IDs, and docs-drift reader injection points;
- prose such as “rules in CLAUDE.md”, “canonical detailed version”, “keeps only a short summary”, “see the … section in CLAUDE.md”, “update AGENTS.md/CLAUDE.md when workflow changes”, and equivalent authority claims that contain no Markdown link;
- tests and fixtures that encode the old authority even when production code no longer does.

The Story must persist or attach a deterministic classification table with `path:line`, matched phrase, consumer category, behavioral/non-behavioral status, target authority, owning implementation Story, and disposition (`migrate`, `retain-as-host-discovery`, `neutral-fixture`, or `remove`). Every scan hit must be classified; an unclassified hit fails that Story's focused verification. The implementation diff is then checked against this complete manifest, not merely against the named baseline below.

This requirement applies to review of B-c1f1 itself: its adversarial documentation verification must execute the bounded enumeration against the current repository and attach the classification summary and zero-unclassified result. The named inventory in this plan cannot be used as self-validating evidence. Successor Stories rerun the same bounded scan because the repository may have acquired new consumers after this plan was accepted.

### Init, profile, sync, and managed assets

- `packages/main/src/init-assets.ts`: generic and global-thin templates, host wording, guide pointers, and the missing dedicated global-thin Claude shape.
- `packages/main/src/core/managed-assets.ts`: managed markers, drift checks, repair, host profile asset sets, and local-edit review.
- `packages/main/src/claude-md-sync.ts` and `packages/main/src/handlers/workflow.ts`: Claude profile-section mutation and rollback; replace whole-document assumptions with managed host-adapter ownership or retire the special sync path.
- `packages/main/src/cli-init.ts`, `packages/main/src/cli-prompts.ts`, and `packages/main/src/cli/command-catalog.ts`: profile selection, generated-asset descriptions, and help text.
- `packages/main/src/core/codex-adapter-checks.ts`: Codex entrypoint verification must continue to target `AGENTS.md` without treating it as Codex-only prose.
- `packages/main/src/tasks/thin-init-assets-smoke.ts` and `packages/main/src/tasks/managed-assets-wrapper-root-smoke.ts`: generation, preservation, profile transition, and wrapper-root regression coverage.

### Mechanical audit and audit triggering

- `packages/main/src/handlers/audit.ts`: replace the hard-coded root `CLAUDE.md` list and “nothing to audit” result with registry-selected canonical docs.
- `packages/main/src/core/audit-scan.ts`: make diagnostics name the actual source document instead of always saying `CLAUDE.md`; scan registry-selected command/path-bearing docs.
- `packages/main/src/core/audit-trigger.ts`: trigger on changes to the canonical audit set rather than only `CLAUDE.md` and package-local Claude files; keep the trigger bounded and deterministic.
- `packages/main/src/tasks/deprecated-gc-smoke.ts:66`: replace the copied `CLAUDE.md has changed` audit-trigger hint fixture and keep its advisory assertion synchronized with the registry-backed trigger text.
- `packages/main/src/handlers/validate-docs-drift.ts`: preserve its pure comparison behavior while accepting content assembled from registry-selected docs.
- `packages/main/src/tasks/audit-esm-smoke.ts`, `packages/main/src/tasks/docs-drift-path-drift-smoke.ts`, and `packages/main/src/tasks/docs-drift-wrapper-root-smoke.ts`: replace Claude-only fixtures with canonical-set fixtures and preserve git-root behavior.

### Review preflight, prompts, and delivery promises

- `packages/main/src/handlers/review-preflight.ts`: replace the default `CLAUDE.md` reader with a registry-backed, git-root-relative canonical reader; preserve dependency injection and fail-closed missing-required-doc behavior.
- `packages/main/src/handlers/agent-prompt.ts` and `packages/main/src/handlers/story-dispatch.ts`: pass bounded document candidates and roles to reviewers instead of implying one giant root contract.
- `packages/main/templates/agents/lattice-review-story-init.md`: stop requiring a complete read of root `CLAUDE.md`; require the thin entrypoint, relevant runbook section, and task-owned normative documents.
- `packages/main/templates/agents/lattice-review-docs.md`: search `AGENTS.md`, `CLAUDE.md`, `.lattice/Lattice.md`, runbook, and task touchpoints through the registry; remove the documentation-only fallback that reads an entire root contract.
- `packages/main/templates/agents/lattice-review-behavior.md`, `lattice-review-channel.md`, `lattice-review-concept.md`, `lattice-review-quality.md`, and `lattice-review-delivery.md`: generalize “promises in CLAUDE.md / README” to promises in changed or registry-selected canonical docs.
- `packages/main/templates/agents/test-intent.md`: update any root-contract routing language found by the pre-implementation scan.

### Lifecycle hints and user-value guidance

- `packages/main/src/handlers/transition-effects.ts`: point user-value acceptance hints to the owning runbook/decision anchor, not a removed `CLAUDE.md` section.
- `packages/main/src/tasks/flow-stability-smoke.ts` and `packages/main/src/tasks/session-brief-prompt-sync-smoke.ts`: assert the new stable target and exact hint projection.
- Any explanatory references in `packages/main/src/core/background-validator.ts`, `advisory.ts`, `finding-verify.ts`, `review-pass-provenance.ts`, `guard-utils.ts`, and `config.ts` must either link to their actual normative owner or be classified as non-behavioral comments; they must not perpetuate a false root authority.

### Active normative-document authority migration

Active decision documents must stop directing agents back to a giant root contract before templates or root files become thin. This is a semantic authority migration, not a link-only cleanup. The first required inventory includes:

- `docs/requirements/decisions/story-lifecycle.md:78`: replace the INIT_CHECK fallback instruction that says the canonical command template lives in a `CLAUDE.md` section with the owning lifecycle/runbook anchor.
- `docs/requirements/decisions/story-lifecycle.md:114`: remove the dual-authority statement that `CLAUDE.md` keeps a summary of the canonical detailed rule; retain one normative owner and point operational readers to the runbook projection.
- `docs/requirements/decisions/root-markdown-migration-execution-solution.md:32`: replace the rule to update root `AGENTS.md` whenever project workflow rules change with thin-entrypoint ownership language; shared workflow changes belong to normative docs/runbook plus mechanical registries.
- `docs/requirements/decisions/root-markdown-migration-execution-solution.md:75`: stop routing active operational material into `AGENTS.md` / `CLAUDE.md`; route it to `.lattice/Lattice.md`, the runbook, or the owning decision while preserving filename-contract entrypoints.
- `docs/requirements/decisions/root-document-migration-guide.md` and every other active normative document returned by the bounded scan: classify and migrate plain-text root-authority phrases even when no Markdown link exists.

Add a retired-authority vocabulary guard over active decision docs, operational docs, runtime hints, and reviewer prompts. The guard must reject unallowlisted prose that assigns shared lifecycle, command, review, evidence, DONE, or user-value authority to root `CLAUDE.md`/`AGENTS.md`. Allowlisted occurrences are limited to host-discovery explanations, historical lineage explicitly labeled as such, neutral parser fixtures, and this migration plan's quoted defect examples. Link and anchor checks remain necessary but cannot replace this guard because plain-text authority phrases contain no link to validate.

### Process and entrypoint verification

- `scripts/verify-process-fact-contract.mjs`: remove `AGENTS.md` and `CLAUDE.md` from detailed lifecycle/review/evidence vocabulary sets; verify those facts in their normative owners and verify root non-duplication separately.
- `scripts/verify-entrypoints.mjs`: test host discovery, managed preservation, guide/runbook links, budgets, import closure, link/anchor integrity, no long-form body, and profile transitions.
- `scripts/verify-codex-assets.mjs`: validate the effective Codex instruction closure and Codex adapter commands without requiring shared operational prose to remain copied in `AGENTS.md`.
- `scripts/verify-proof-or-stop-prompt-baseline.mjs`: update prompt overlap expectations and forbid retired Claude-first authority phrases.
- `packages/main/src/tasks/cli-surface-smoke.ts`, `field-regression-cli-smoke.ts`, `cli-argument-ergonomics-smoke.ts`, and other fixtures containing `CLAUDE.md` as generic sample data must be classified: update behavior assertions, but retain neutral filename examples when they are only parser fixtures.

### Auxiliary and runtime discovery

- `packages/main/src/handlers/aux-doc.ts`: discover `.lattice/Lattice.md` and the runbook in addition to root entrypoints; expose roles without claiming every discovered document is normative.
- `packages/main/src/core/runtime-environment-checks.ts`: keep root marker discovery host-neutral and include the canonical guide where appropriate.
- `packages/main/src/core/rollout-check.ts`: stop treating `CLAUDE.md` or retired root `LATTICE.md` as the Lattice guide; recognize `.lattice/Lattice.md` explicitly.
- `packages/main/src/core/cluster-compute.ts`: update common-document assumptions used for project clustering.
- `packages/main/src/core/dirty-worktree.ts`: retain root docs in material/dirty classification where required; thinness does not make them non-material.
- `packages/main/src/handlers/session.ts`, `story-create.ts`, `init-check.ts`, `checklist.ts`, `done-effects.ts`, `recover-evidence.ts`, `artifact-declare.ts`, `finding.ts`, `gap-log.ts`, `story-review.ts`, and `validate-lint.ts`: classify references found by the migration scan and route behavior-affecting document lookup through the registry.

This inventory is a migration baseline, not permission to ignore new hits. Each implementation Story must attach the complete bounded-scan manifest, classification totals, and zero-unclassified result to its verification evidence. A selected-file grep or an unexplained excluded hit does not satisfy the verification narrative.

## B-c1f1 Baseline Scan Evidence — 2026-07-15

The B-c1f1 implementer ran the required bounded scan in the Story worktree and froze the inspectable baseline at commit `7d7bebed3815af54e6fb8cd7303faa2bd7cb0147`, which contains this evidence section. The appendix at the end of this plan records every one of that snapshot's 600 matched lines. The reproducible command shape was:

```bash
git grep -nI -E '(CLAUDE\.md|AGENTS\.md|(^|[^./])LATTICE\.md|\.lattice/Lattice\.md|((canonical|complete|shared|workflow|process|rule|instruction|summary|detail|authority|规范|权威|规则|详见).{0,80}(Claude|AGENTS|Lattice))|((Claude|AGENTS|Lattice).{0,80}(canonical|complete|shared|workflow|process|rule|instruction|summary|detail|authority|规范|权威|规则|详见)))' \
  -- AGENTS.md CLAUDE.md .lattice/Lattice.md docs packages/main/src packages/main/templates scripts \
  ':(exclude)docs/story/**' ':(exclude)tests/fixtures/**' \
  ':(exclude)packages/main/tests/fixtures/**' ':(exclude)packages/main/dist/**' \
  ':(exclude)node_modules/**' ':(exclude).worktrees/**' ':(exclude).omx/**'
```

The authority-word alternatives were applied in both directions around the host/document terms. The scan therefore covered filename/path literals plus plain-text authority claims. It enumerated tracked text only; generated dist, dependencies, worktrees, Story stores, fixture stores, and disabled legacy areas were excluded.

Classification was deterministic and line-level. Root entrypoint and host-neutral guide hits were `retain-as-host-discovery`; this migration plan and explicitly historical/evidence material were `neutral-fixture`; active normative, operational, runtime, audit, review, verifier, and unambiguously behavioral test hits were conservatively `migrate`. A test line was `neutral-fixture` only when its matched text explicitly identified a fixture/example/sample/smoke. This conservative rule prevents an ambiguous executable hit from being silently allowlisted.

| Consumer category | Retain as host discovery | Migrate | Neutral fixture | Total hit lines |
|---|---:|---:|---:|---:|
| Host-neutral guide | 1 | 0 | 0 | 1 |
| Root entrypoint | 14 | 0 | 0 | 14 |
| Operational/other docs | 0 | 17 | 0 | 17 |
| Active normative docs | 0 | 106 | 0 | 106 |
| This migration plan | 0 | 0 | 72 | 72 |
| Init/managed assets | 0 | 92 | 0 | 92 |
| Other source/comments | 0 | 51 | 0 | 51 |
| Audit/docs-drift | 0 | 55 | 0 | 55 |
| Aux/runtime discovery | 0 | 11 | 0 | 11 |
| Review/preflight/prompts | 0 | 32 | 0 | 32 |
| Lifecycle hints | 0 | 16 | 0 | 16 |
| Verification/test fixtures | 0 | 130 | 2 | 132 |
| Other tracked text | 0 | 1 | 0 | 1 |
| **Total** | **15** | **511** | **74** | **600** |

The scan covered **134 unique files**. Every returned line received both a consumer category and a disposition: **0 unclassified**.

High-risk current hits that establish implementation ownership include:

| Current source | Hit lines | Classification / required owner |
|---|---:|---|
| `docs/requirements/decisions/story-lifecycle.md:78,114` | 2 | Active normative authority; migrate in Story 5 |
| `docs/requirements/decisions/root-markdown-migration-execution-solution.md` including lines 32 and 75 | 14 | Active normative authority; migrate in Story 5 |
| `docs/requirements/decisions/root-document-migration-guide.md` | 7 | Active normative authority/lineage; semantically classify and migrate in Story 5 |
| `packages/main/src/core/audit-trigger.ts` | 8 | Audit/docs-drift; migrate in Story 3 |
| `packages/main/src/handlers/audit.ts` | 5 | Audit/docs-drift; migrate in Story 3 |
| `packages/main/src/handlers/review-preflight.ts` | 5 | Review/preflight; migrate in Story 4 |
| `packages/main/src/tasks/deprecated-gc-smoke.ts:66` | 1 | Audit-trigger fixture; migrate with Story 3 rather than allowlisting it |
| `packages/main/src/handlers/transition-effects.ts` | 3 | Lifecycle/user-value hints; migrate in Story 4 |
| `scripts/verify-process-fact-contract.mjs` | 3 | Process verifier; migrate in Story 6 |
| `scripts/verify-entrypoints.mjs` | 80 | Entrypoint verification/fixtures; classify individual assertions across Stories 1, 6, and 7 |

This is a lexical routing baseline, not proof that all 0-unclassified rows are already correct. The large conservative `migrate` set intentionally requires the owning Stories to perform semantic review and narrow only documented host-discovery, historical, or neutral-fixture exceptions. Successor Stories must rerun the scan and may not reuse these totals after the tree changes.

## Red-Before / Green-After Verification Contract

The first implementation Story adds tests before changing production consumers. The red suite must fail against the current repository for the intended reason, with an artifact recording the failing assertion.

| Area | Red assertion before migration | Green assertion after migration |
|---|---|---|
| Size | Managed `AGENTS.md` exceeds its selected ceiling or a long-form fixture is accepted | Managed bodies meet line and byte ceilings; user-owned text is measured separately |
| Effective host rules | Claude import/delegation and closure are not resolved | Codex and Antigravity resolve `AGENTS.md`; Claude resolves `CLAUDE.md` plus shared `AGENTS.md`, with deduplication |
| Required constraints | Deleting all root prose can still pass a pointer-only check | Effective host closures directly expose session-first, user-priority, no-direct-store-edit, lifecycle, ownership safety, and user-value constraints |
| Links and anchors | A stale local anchor or retired target is accepted | Missing file, missing anchor, retired authority, or import/navigation cycle fails |
| Non-duplication | Root files may contain full lifecycle/Finding/DONE sections | Lifecycle tables, Finding schema bodies, reviewer manuals, CLI encyclopedias, and legacy compatibility chapters fail root checks |
| Audit source | A bad command placed only in the canonical runbook is invisible | `lattice audit --framework` reports the runbook path and bad command |
| Docs drift | Preflight reads only root `CLAUDE.md` | Preflight reads the registry-selected set from the git root and reports missing required sources |
| Process facts | Thin root files fail because detailed terms are absent | Detailed terms are required only in owning decision docs; removing a required fact there fails |
| Retired prose authority | Plain-text “canonical rule is in CLAUDE.md” statements pass because they contain no link | Retired-authority vocabulary guard reports the exact active document and phrase unless it is a bounded host-discovery, historical-lineage, or neutral-fixture allowlist entry |
| Review routing | Documentation-only review falls back to reading all of `CLAUDE.md` | Reviewer receives bounded registry candidates plus touchpoints and never mandates a giant root scan |
| Generation | Global-thin templates mislabel `AGENTS.md` as Codex-only or produce an unsuitable Claude copy | Each profile produces exactly the discovery assets for that host and preserves user-owned regions |
| Projection drift | A runbook command, phase, reviewer lane, or DONE step can contradict registries | Projection verifier rejects unknown commands and mismatched lifecycle/reviewer/DONE facts |

### Required failure exercises

Implement `packages/main/src/tasks/thin-entrypoint-failure-exercises-smoke.ts` as a temporary-directory/in-memory harness. Each row below must be exercised, not merely described:

| Failure | Fixture / setup | Expected failure | Recovery assertion | Owning Story |
|---|---|---|---|---|
| Stale link or anchor | Create a temporary canonical registry containing `.lattice/Lattice.md` with a link to `docs/dev/lattice-agent-runbook.md#missing-anchor`; create the target file without that heading | Link/anchor verifier exits non-zero and reports the source path, target path, and missing anchor; no fallback to the legacy root makes it pass | Add the exact target heading, rerun, and assert the same fixture passes without changing the registry role | Story 1 (validator and exercise), re-run in Story 2 against real guide/runbook |
| Conflicting runbook command | Put ``lattice command_that_does_not_exist`` in a temporary runbook selected by `docsForMechanicalAudit()` while the command registry omits it | Projection/audit test exits non-zero and attributes the unknown command to the runbook, not `CLAUDE.md` | Replace it with a registered command or deliberately add the command through its own reviewed runtime Story; rerun and assert green | Story 3 |
| Failed red test | Run the new root non-duplication and canonical-audit tests against a frozen legacy-root fixture before production changes; store the assertion ID and non-zero result in red evidence | Harness fails specifically because the fixture contains the lifecycle body and the bad runbook command is invisible; a passing or unrelated failure invalidates the red evidence | Implement the registry/validator path without weakening the assertion, then replay the identical fixture pair and show the expected legacy fixture remains rejected while the canonical fixture passes | Story 1 |
| Partial template migration | In a temporary initialized project, preserve user text around managed markers, inject a write failure after one host asset is staged but before the asset set is committed, and also test a mixed old-`AGENTS.md`/new-`CLAUDE.md` pair | Managed update fails atomically; no half-thin discovery set is accepted; user-owned text and the previously valid asset set are byte-identical | Remove the injected failure, rerun the full asset transaction, resolve the Claude import closure, and execute canonical audit plus review-preflight smoke on the fresh init | Story 7 |
| B-e514 remains in TEST | Use an injected lifecycle/store double representing B-e514 in TEST with the old process-fact verifier failure and no current canonical-only full-suite evidence; do not read or mutate the real Story store | Convergence helper refuses a DONE/superseded claim and reports prerequisite contract Stories / stale evidence as blockers; it must not create a second root-doc owner | Feed the double completed prerequisite receipts, merged-main state, refreshed review/delivery evidence, and green full-suite evidence; assert convergence becomes eligible while B-e514 remains the sole owner | Story 8 |

The failure-exercise smoke must be registered in the applicable focused test commands and in `npm test`. Its temporary repositories must not depend on or mutate the developer's actual root entrypoints, Story data, or fixture data.

Minimum green commands after every applicable slice are:

```bash
npm --prefix packages/main run build
node scripts/verify-entrypoints.mjs
node scripts/verify-process-fact-contract.mjs
node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js
npm test
```

Focused audit, docs-drift, init-asset, managed-asset, wrapper-root, prompt-baseline, Codex-adapter, link/anchor, and projection tests must run in the Stories that own those surfaces. Passing a focused subset must not be described as full-suite success.

## Implementation Sequence

Each stage is a separate Story with a focused commit set, fresh review, and a clean rollback. Later Stories depend on earlier green contracts; no stage declares the old contract retired before cutover.

### Story 1 — Contract tests and canonical registry

1. Add the typed canonical-document registry and pure selectors.
2. Add red fixtures for budgets, imports, links/anchors, canonical audit reachability, root non-duplication, and process-fact ownership.
3. Record red evidence against current behavior, then implement only enough registry/validator infrastructure for the new tests to exercise real selectors.
4. Keep existing runtime consumers unchanged.

Rollback: revert the registry and its isolated tests; no generated assets or runtime lookup has changed.

### Story 2 — Canonical guide and operational projection

1. Repair `.lattice/Lattice.md` branding, self-paths, command examples, and authority wording.
2. Add `docs/dev/lattice-agent-runbook.md` with bounded operational sections and links to the owning decisions.
3. Add link/anchor and registry-projection verification.
4. Do not edit the root `AGENTS.md` or `CLAUDE.md`; B-e514 remains their sole owner.

Rollback: revert the guide/runbook and registry entries; root discovery remains on the legacy contract.

### Story 3 — Audit, docs-drift, and discovery dual-read

1. Move audit, audit trigger, docs-drift, auxiliary discovery, and runtime/rollout discovery to registry selectors.
2. During dual-read, scan canonical docs first and legacy root `CLAUDE.md` second, normalize facts, deduplicate by the source-independent semantic `fingerprint`, and merge all source paths/anchors/roles into provenance.
3. Fail closed on semantic conflicts or fingerprint collisions, and emit a structured advisory for each legacy-only fingerprint so cutover readiness is observable.
4. Update `packages/main/src/tasks/deprecated-gc-smoke.ts:66` with the registry-backed audit-trigger fixture and preserve the deprecated-GC advisory assertion.
5. Preserve git-root/wrapper-root semantics and existing audit locking.

Rollback: restore the previous consumers; no canonical files or generated assets need deletion.

### Story 4 — Review preflight, prompts, and lifecycle hints

1. Route preflight and reviewer prompts through bounded canonical candidates plus Story touchpoints.
2. Replace all user-value links and Claude-first promise language with owning runbook/decision anchors.
3. Prove documentation-only review does not fall back to a full root scan.
4. Keep legacy fallback diagnostics active.

Rollback: revert prompt/hint routing; dual-read audit remains safe and the old root contract is still present.

### Story 5 — Active normative-authority migration and vocabulary guard

1. Run the repository-wide bounded scan and commit the complete classification manifest with zero unclassified hits.
2. Migrate the identified authority statements in `story-lifecycle.md`, `root-markdown-migration-execution-solution.md`, `root-document-migration-guide.md`, and every other active normative hit to the correct guide, runbook, decision, or mechanical owner.
3. Add the retired-authority vocabulary guard for active decisions, operational docs, runtime hints, and reviewer prompts, with narrow documented allowlists for host discovery, explicitly labeled history, neutral fixtures, and quoted migration defects.
4. Prove that a plain-text legacy authority phrase fails even when every Markdown link and anchor is valid.

Dependency: Stories 2–4 must already provide valid destination anchors and bounded consumers. Generated templates and root entrypoints remain unchanged.

Rollback: revert the normative wording and guard together; dual-read consumers and the still-full legacy root contract remain available while the defect is corrected.

### Story 6 — Verifier ownership readiness gate

1. Change process-fact verification so detailed lifecycle, review, evidence, and DONE facts are checked only in their canonical normative owners.
2. Implement root-budget, effective-import-closure, required-constraint, non-duplication, and link/anchor enforcement. Exercise hard failure against thin contract fixtures, while keeping one explicit repository-root migration exemption bound only to B-e514 until Story 8; the exemption must not apply to generated templates or other projects.
3. Make all behavior-affecting canonical path sets derive from the shared registry or its generated projection.
4. Require the bounded-scan classification manifest and retired-authority guard to be green.
5. Run the full red-to-green matrix and complete suite while the repository root and generated templates still use the legacy-compatible bodies; the output must identify the narrow B-e514 root-budget exemption rather than presenting the real root as already thin.

Readiness condition: canonical audit, docs-drift, review/preflight routing, normative authority, and verifiers pass with an empty semantic legacy-only fingerprint set and an empty conflict/collision set for at least one complete full-suite run at the same HEAD. This authorizes template work; it does not retire the old contract.

Rollback: revert this verifier Story to restore dual acceptance; do not copy old prose back into templates.

### Story 7 — Init, managed assets, and host import closure

This is the first Story allowed to generate thin entrypoints. It starts only after Stories 1–6 are green, so a fresh init cannot receive thin documents while audit, review/preflight, normative docs, or verifiers still require the old body.

1. Update generic and global-thin templates for the host matrix.
2. Implement Claude shared-rule import/delegation and effective-closure validation.
3. Generalize or retire `claude-md-sync.ts` whole-document assumptions while preserving supported profile behavior.
4. Make multi-asset managed updates atomic and prove repository-local text survives rollback and successful repair.
5. Remove any template-side migration exemption, run the partial-template failure exercise, then initialize fresh Codex, Claude, Antigravity, and combined-profile temporary projects and run hard budget/import checks, canonical audit, plus review-preflight smoke against each applicable discovery closure.

Compatibility: existing repositories keep their current valid root assets until explicitly updated; newly initialized repositories are thin only because all canonical consumers and normative sources are already ready. Legacy fallback remains enabled for existing repositories but must contribute no legacy-only semantic fingerprint or conflict to a fresh thin init.

Rollback: revert template/sync changes or the atomic managed-asset transaction; previously generated and legacy managed blocks remain recognized by compatibility detection, and consumer dual-read remains active.

### Story 8 — B-e514 root-entrypoint convergence

B-e514 remains the single owner of product edits to root `AGENTS.md` and `CLAUDE.md`. No implementation Story above may edit those two repository-root files, although template fixtures may generate them in temporary directories.

After Stories 1–7 merge to main, the B-e514 owner must:

1. Merge current main into the B-e514 worktree using the lifecycle-supported convergence path.
2. Update its thin files to the final contract: shared constraints and local user region in `AGENTS.md`; Claude import/delegation and Claude-only adapter material in `CLAUDE.md`.
3. Preserve the repository-local OMX prohibition outside the managed block.
4. Remove the B-e514-specific repository-root budget exemption and prove the actual root files pass the same hard checks as fresh init.
5. Re-run entrypoint, process-fact, audit reachability, managed preservation, build, routine validation, DONE-required validation when configured, and the full suite.
6. Refresh all stale review, delivery, and verification evidence indicated by Lattice before DONE.

B-e514 is not silently superseded and its scope is not expanded to code/templates/tests. If it becomes unrecoverable, a human must explicitly discard it and create one replacement root-entrypoint Story; the replacement then becomes the sole owner, and B-e514's commits must not also be merged. Concurrent root-document owners are prohibited.

Rollback before B-e514 DONE: revert only its root-doc commit in its worktree. Rollback after DONE: use a new Story that restores the last known good thin entrypoints; never resurrect the giant contract as an emergency unreviewed edit.

### Story 9 — Legacy fallback retirement

1. Remove dual-read fallback and its compatibility diagnostics only after B-e514 is DONE and a fresh full-suite run proves canonical-only operation.
2. Remove obsolete Claude-only helpers, path arrays, comments, and test fixtures that no longer represent supported behavior.
3. Keep filename compatibility assets and managed-block migration recognition for the documented support window.
4. Record the retirement point and replacement sources in the process-fact and root-document migration documentation.

Rollback: restore only the registry's legacy fallback and diagnostic path. Do not restore duplicated root prose.

## Compatibility and Cutover Rules

Dual-read is mandatory between the first consumer migration and final retirement:

1. Canonical registry paths are authoritative candidates.
2. Legacy root `CLAUDE.md` is a compatibility fallback, never the destination for new facts.
3. Results are deduplicated by the normalized semantic fingerprint; every contributing path, anchor, role, host, and raw-text hash remains in provenance. Path/anchor identity must never decide semantic equality.
4. Missing required canonical docs fail closed once their owning Story declares them required; legacy presence cannot mask a missing required source.
5. A legacy-only semantic fingerprint, semantic conflict, or fingerprint collision blocks readiness and retirement and identifies the fact plus all provenance that needs correction.
6. No generated template or repository root entrypoint may become thin until audit/docs-drift/discovery, review/preflight/prompts, lifecycle hints, active normative documents, retired-authority guard, process-fact verification, and entrypoint verification are all canonical-ready and green. Story 6 records that readiness; Story 7 is the first template-thinning owner; Story 8 is the first repository-root-thinning owner.
7. A fresh-init test must run the applicable canonical audit and review-preflight path against the generated host closure. Merely checking that files exist or contain pointers is insufficient.
8. “Old contract retired” may be written only after B-e514 convergence and canonical-only audit, review preflight, retired-authority guard, verifier, build, and full-suite tests pass at the same HEAD.

## Rollback and Failure Recovery

- A failed red test is evidence, not permission to weaken the assertion. Confirm it fails for the intended legacy behavior before implementation.
- A partial template migration rolls back Story 7 while dual-read remains enabled; atomic managed updates and preservation checks prevent a half-thin host closure or loss of local constraints.
- A broken link or conflicting runbook command fails the projection/entrypoint verifier and blocks cutover.
- A canonical audit miss restores or retains legacy fallback until the registry selector and scanner are fixed.
- If B-e514 is still blocked in TEST, do not force DONE and do not move its root edits into another active Story. Complete the prerequisite contract Stories, merge main, refresh evidence, and let its sole owner converge it.
- Rollback commits must preserve audit provenance and must not directly edit Story or fixture stores.
- No rollback may re-label legacy Gemini, `CODEX.md`, or `AGY.md` conventions as supported architecture.

## Final Acceptance

The migration is accepted only when all of the following are true at one reviewed HEAD:

- Codex CLI and Antigravity CLI discover the effective shared constraints through `AGENTS.md`; Claude Code CLI discovers `CLAUDE.md` and resolves the shared `AGENTS.md` rules without a copied common body.
- `.lattice/Lattice.md` is the preserved, unique host-neutral navigation entry and links to the runbook and normative owners.
- Root managed bodies satisfy line, byte, import-closure, required-constraint, link/anchor, and non-duplication checks.
- The repository-wide bounded scan manifest has zero unclassified hits, and no active normative document or prompt assigns shared process authority to root `CLAUDE.md`/`AGENTS.md` outside the narrow retired-authority allowlist.
- Repository-local OMX and user-owned constraints survive init, profile change, repair, and managed update without entering universal templates.
- Freshly initialized Codex, Claude, Antigravity, and combined-profile fixtures pass host discovery, canonical audit, and applicable review-preflight checks with empty legacy-only fingerprint and conflict/collision sets.
- Audit and docs-drift detect an invalid command placed only in the canonical runbook and report the correct source.
- Reviewer routing is bounded by registry roles and Story touchpoints and never mandates reading a giant root contract.
- Detailed process-fact verification succeeds from canonical normative documents and fails if an owned fact is removed there.
- All named focused tests, build, routine Story validation, configured DONE-required validation, and `npm test` pass with fresh evidence.
- B-e514 is either DONE as the sole root-document owner or explicitly discarded and replaced by exactly one human-approved owner; both implementations are never merged.
- Legacy fallback is removed only after canonical-only evidence is green.

This plan does not claim that any implementation Story is complete, that any host has been validated after migration, or that B-e514 is unblocked. Those claims require the execution and evidence described above.

## Appendix A — B-c1f1 Line-Level Classification Manifest

<details>
<summary>600-row TSV manifest for scan snapshot <code>7d7bebed3815af54e6fb8cd7303faa2bd7cb0147</code></summary>

The TSV has exactly 600 data rows. Its digest covers the UTF-8 bytes from the header through the final row, with one `\n` after every line: `SHA-256: 52b372438eb5a890c238079a3672d2797e0a4333b7dd01cf37eb2887246fceba`.

```tsv
path:line	category	disposition	owning Story / target
.lattice/Lattice.md:6	host-neutral guide	retain-as-host-discovery	Story 2 / host-neutral guide
AGENTS.md:2	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
AGENTS.md:18	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
AGENTS.md:136	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
AGENTS.md:303	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
CLAUDE.md:2	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
CLAUDE.md:81	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
CLAUDE.md:87	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
CLAUDE.md:88	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
CLAUDE.md:348	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
CLAUDE.md:373	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
CLAUDE.md:433	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
CLAUDE.md:550	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
CLAUDE.md:672	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
CLAUDE.md:774	root entrypoint	retain-as-host-discovery	Story 8 / root-entrypoint convergence
docs/CLI.md:39	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/CLI.md:169	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/CLI.md:188	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/CLI.md:216	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/CLI.md:232	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/CLI.md:671	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/CLI.md:724	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/CLI.md:734	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/CLI.md:771	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/CLI.md:879	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/guide-scope-guard.md:209	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/guide.md:142	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/metadata/task.json:14	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/metadata/task.json:2056	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/metadata/task.json:2058	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/requirements/baselines/proof-or-stop-prompt-baseline.json:1675	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/requirements/baselines/proof-or-stop-prompt-baseline.json:1963	operational/other docs	migrate	Story 5 / operational-authority cleanup
docs/requirements/decisions/authority-client-role.md:110	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/authority-client-role.md:204	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/authority-client-role.md:212	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/autopilot-v2-reliability-execution-plan.md:23	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cc-learnings.md:179	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cc-learnings.md:199	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cc-learnings.md:211	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cc-learnings.md:242	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cc-learnings.md:243	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cc-learnings.md:264	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cc-learnings.md:739	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cc-learnings.md:795	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cc-learnings.md:811	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cc-learnings.md:821	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cc-learnings.md:833	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cell06-docker-server-execution-checklist.md:497	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md:894	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md:895	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md:896	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md:901	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md:971	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md:1148	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/done-full-test-gate-execution-plan.md:164	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/experience-layer-ablation-causal-validation-execution-plan.md:293	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/f009-layer2-engineering-proof-gap-execution-plan.md:418	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/host-neutral-observability-console.md:4	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/host-neutral-observability-console.md:16	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/host-overflow.md:26	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/host-overflow.md:27	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/host-overflow.md:47	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/host-overflow.md:118	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/host-overflow.md:189	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/host-overflow.md:227	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-authority-live-integration.md:539	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-authority-live-integration.md:1258	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-codex-command-boundary-execution-plan.md:179	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-codex-command-boundary-execution-plan.md:180	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-codex-command-boundary-execution-plan.md:282	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-codex-command-boundary-execution-plan.md:287	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-console-demo-mvp-requirements.md:52	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md:59	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-runtime-owned-agent-assets-execution-plan.md:112	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-runtime-owned-agent-assets-execution-plan.md:333	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-runtime-owned-agent-assets-execution-plan.md:334	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-runtime-owned-agent-assets-execution-plan.md:503	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md:118	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/legacy-to-lattice-role-naming-execution-plan.md:35	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/legacy-to-lattice-role-naming-execution-plan.md:106	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/legacy-to-lattice-role-naming-execution-plan.md:167	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/legacy-to-lattice-role-naming-execution-plan.md:183	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lifecycle-artifact-scope.md:170	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lifecycle-artifact-scope.md:187	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lifecycle-artifact-scope.md:252	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/lifecycle-artifact-scope.md:253	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/milestone-ledger-status-review-and-hardening-plan.md:252	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/orchestrate-retirement.md:33	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/owner-session-contract-execution-plan.md:266	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/pos-agent-drivability-optimization.md:96	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/pos-agent-drivability-optimization.md:99	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/pos-agent-drivability-optimization.md:151	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md:99	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:6	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:13	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:23	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:24	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:25	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:27	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:32	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:34	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:36	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:37	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:39	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:41	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:58	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:66	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:87	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:95	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:98	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:100	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:103	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:111	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:112	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:116	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:120	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:122	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:149	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:157	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:159	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:170	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:172	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:177	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:178	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:179	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:180	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:182	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:186	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:188	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:189	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:190	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:195	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:203	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:204	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:205	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:206	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:209	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:213	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:215	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:216	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:217	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:221	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:223	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:235	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:236	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:288	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:289	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:294	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:296	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:297	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:298	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:307	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:308	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:310	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:342	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:345	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:352	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:396	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:407	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:412	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:436	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:458	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:459	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:461	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/proof-or-stop-thin-entrypoint-contract-migration-execution-plan.md:463	migration plan	neutral-fixture	B-c1f1 / planning evidence
docs/requirements/decisions/review-run-start-signed-workspace-resolution-execution-plan.md:85	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/review-run-start-workspace-diagnostics-execution-plan.md:212	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:252	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:264	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:273	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:285	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:290	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:315	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:338	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:381	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:394	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:433	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:455	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:637	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:656	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:947	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/role-separation.md:982	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-document-migration-guide.md:15	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-document-migration-guide.md:19	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-document-migration-guide.md:20	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-document-migration-guide.md:23	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-document-migration-guide.md:46	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-document-migration-guide.md:71	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-document-migration-guide.md:112	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:16	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:17	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:21	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:28	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:29	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:32	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:56	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:72	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:74	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:75	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:78	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:79	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:93	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/root-markdown-migration-execution-solution.md:129	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/session-ownership-and-write-leases.md:260	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/stack-layering.md:316	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/story-lifecycle.md:78	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/story-lifecycle.md:114	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/testing-infra.md:118	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/testing-infra.md:148	active normative docs	migrate	Story 5 / normative-authority migration
docs/requirements/decisions/tier-c-crosshost-quorum-execution-plan.md:161	active normative docs	migrate	Story 5 / normative-authority migration
packages/main/src/claude-md-sync.ts:2	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/claude-md-sync.ts:14	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/claude-md-sync.ts:73	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-engine.ts:730	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/cli-engine.ts:758	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/cli-init.ts:198	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:199	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:209	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:215	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:247	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:249	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:255	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:269	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:479	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:488	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:825	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:833	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:835	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:839	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:841	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:845	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:847	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:849	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:1077	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-init.ts:1080	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli-prompts.ts:278	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli/command-catalog.ts:1933	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli/command-catalog.ts:1934	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli/command-catalog.ts:1935	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli/command-catalog.ts:1942	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli/command-catalog.ts:2283	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/cli/help-renderer.ts:235	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/cli/ownership-gate.ts:174	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/cli/ownership-gate.ts:183	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/advisory.ts:21	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/audit-meta-store.ts:87	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/audit-meta-store.ts:243	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/audit-scan.ts:2	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-scan.ts:23	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-scan.ts:72	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-scan.ts:74	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-scan.ts:112	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-scan.ts:129	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-scan.ts:195	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-scan.ts:268	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-scan.ts:336	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-trigger.ts:2	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-trigger.ts:132	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-trigger.ts:140	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-trigger.ts:147	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-trigger.ts:165	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-trigger.ts:178	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-trigger.ts:235	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/audit-trigger.ts:289	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/core/background-validator.ts:7	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/cluster-compute.ts:37	aux/runtime discovery	migrate	Story 3 / discovery registry
packages/main/src/core/codex-adapter-checks.ts:100	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/command-policy.ts:475	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/config.ts:13	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/dirty-worktree.ts:278	aux/runtime discovery	migrate	Story 3 / discovery registry
packages/main/src/core/dirty-worktree.ts:279	aux/runtime discovery	migrate	Story 3 / discovery registry
packages/main/src/core/finding-verify.ts:128	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/guard-utils.ts:3	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/guard-utils.ts:91	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-brand.ts:14	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-dispatch.ts:886	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-dispatch.ts:1828	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-dispatch.ts:1829	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-dispatch.ts:1831	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-dispatch.ts:2511	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-dispatch.ts:2661	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-dispatch.ts:2703	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-dispatch.ts:2727	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-evidence.ts:82	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-evidence.ts:100	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-evidence.ts:268	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/lattice-hosts.ts:389	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/managed-assets.ts:500	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:501	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:532	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:579	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:585	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:591	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:616	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:622	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:642	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:643	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:645	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:671	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:672	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:674	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:693	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:694	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:707	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:708	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:731	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:732	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:783	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/managed-assets.ts:784	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/core/process-fact-levels.ts:209	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/review-pass-provenance.ts:93	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/rollout-check.ts:230	aux/runtime discovery	migrate	Story 3 / discovery registry
packages/main/src/core/rollout-check.ts:231	aux/runtime discovery	migrate	Story 3 / discovery registry
packages/main/src/core/rollout-check.ts:232	aux/runtime discovery	migrate	Story 3 / discovery registry
packages/main/src/core/rollout-check.ts:381	aux/runtime discovery	migrate	Story 3 / discovery registry
packages/main/src/core/rollout-check.ts:382	aux/runtime discovery	migrate	Story 3 / discovery registry
packages/main/src/core/rollout-check.ts:386	aux/runtime discovery	migrate	Story 3 / discovery registry
packages/main/src/core/runtime-artifact-registry.ts:198	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/runtime-artifact-registry.ts:200	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/core/runtime-environment-checks.ts:593	aux/runtime discovery	migrate	Story 3 / discovery registry
packages/main/src/handlers/agent-prompt.ts:13	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/src/handlers/artifact-declare.ts:11	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/audit.ts:4	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/audit.ts:10	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/audit.ts:101	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/audit.ts:103	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/audit.ts:107	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/aux-doc.ts:23	aux/runtime discovery	migrate	Story 3 / discovery registry
packages/main/src/handlers/checklist.ts:564	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/doctor.ts:151	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/done-effects.ts:1036	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/finding.ts:138	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/finding.ts:194	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/gap-log.ts:21	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/init-check.ts:74	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/init-check.ts:76	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/init-check.ts:197	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/recover-evidence.ts:131	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/review-preflight.ts:153	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/src/handlers/review-preflight.ts:178	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/src/handlers/review-preflight.ts:226	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/src/handlers/review-preflight.ts:296	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/src/handlers/review-preflight.ts:299	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/src/handlers/session.ts:9	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/story-create.ts:386	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/story-create.ts:993	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/story-create.ts:1126	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/story-dispatch.ts:11	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/src/handlers/story-dispatch.ts:30	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/src/handlers/story-dispatch.ts:386	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/src/handlers/story-review.ts:477	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/transition-effects.ts:220	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/handlers/transition-effects.ts:391	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/handlers/transition-effects.ts:394	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/handlers/validate-docs-drift.ts:2	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:15	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:71	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:123	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:129	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:139	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:151	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:162	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:168	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:178	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:183	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:186	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:192	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:198	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:217	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:220	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:237	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:353	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:434	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:436	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:450	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:496	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:521	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-docs-drift.ts:535	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/handlers/validate-lint.ts:574	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/handlers/workflow.ts:49	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/handlers/workflow.ts:50	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/handlers/workflow.ts:57	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/init-assets.ts:20	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/init-assets.ts:25	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/init-assets.ts:38	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/init-assets.ts:43	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/init-assets.ts:50	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/init-assets.ts:58	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/init-assets.ts:63	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/init-assets.ts:84	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/init-assets.ts:97	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/init-assets.ts:102	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/init-assets.ts:252	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/providers/claude-cli.ts:284	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/providers/types.ts:91	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/tasks/audit-esm-smoke.ts:10	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/tasks/cli-argument-ergonomics-smoke.ts:20	verification/test fixtures	neutral-fixture	Story 6 / verification-fixture classification
packages/main/src/tasks/cli-argument-ergonomics-smoke.ts:23	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/cli-argument-ergonomics-smoke.ts:27	verification/test fixtures	neutral-fixture	Story 6 / verification-fixture classification
packages/main/src/tasks/cli-argument-ergonomics-smoke.ts:30	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/cli-surface-smoke.ts:59	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/cli-surface-smoke.ts:60	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/cli-surface-smoke.ts:68	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/deprecated-gc-smoke.ts:66	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/tasks/docs-drift-path-drift-smoke.ts:4	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/tasks/docs-drift-path-drift-smoke.ts:8	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/tasks/docs-drift-path-drift-smoke.ts:226	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/tasks/docs-drift-path-drift-smoke.ts:320	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/tasks/docs-drift-wrapper-root-smoke.ts:34	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/tasks/docs-drift-wrapper-root-smoke.ts:74	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/tasks/docs-drift-wrapper-root-smoke.ts:215	audit/docs-drift	migrate	Story 3 / audit-docs-drift
packages/main/src/tasks/field-regression-cli-smoke.ts:1772	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/flow-stability-smoke.ts:1048	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/flow-stability-smoke.ts:1085	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/flow-stability-smoke.ts:1086	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/flow-stability-smoke.ts:1087	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/flow-stability-smoke.ts:1090	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/flow-stability-smoke.ts:1091	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/flow-stability-smoke.ts:1092	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/flow-stability-smoke.ts:3389	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/flow-stability-smoke.ts:3399	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/flow-stability-smoke.ts:3496	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/flow-stability-smoke.ts:3903	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/flow-stability-smoke.ts:3914	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/gap-log-smoke.ts:86	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/gap-log-smoke.ts:107	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/init-check-atomicity-smoke.ts:215	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/init-check-atomicity-smoke.ts:347	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/main-write-lock-coverage.ts:9	other source/comments	migrate	Story 5 / source-authority cleanup
packages/main/src/tasks/managed-assets-wrapper-root-smoke.ts:9	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/managed-assets-wrapper-root-smoke.ts:116	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/managed-assets-wrapper-root-smoke.ts:138	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/managed-assets-wrapper-root-smoke.ts:146	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/playbook-runtime-memory-index-smoke.ts:124	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/playbook-runtime-memory-index-smoke.ts:578	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/prompt-registry-smoke.ts:89	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/provider-claude-smoke.ts:6	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/provider-claude-smoke.ts:250	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/repro-first-candidate-smoke.ts:46	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/repro-first-candidate-smoke.ts:47	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/retired-root-guard-smoke.ts:25	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/retired-root-guard-smoke.ts:30	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/retired-root-guard-smoke.ts:36	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/retired-root-guard-smoke.ts:48	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/review-host-execution-readiness-smoke.ts:189	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/session-brief-prompt-sync-smoke.ts:38	lifecycle hints	migrate	Story 4 / lifecycle hint routing
packages/main/src/tasks/story-create-concurrency-smoke.ts:330	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/thin-init-assets-smoke.ts:15	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:166	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:171	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:174	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:176	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:179	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:180	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:181	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:182	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:183	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:185	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:186	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:187	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:188	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:200	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:216	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:218	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:227	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:232	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:246	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:266	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/thin-init-assets-smoke.ts:277	init/managed assets	migrate	Story 7 / init-managed assets
packages/main/src/tasks/unattended-dispatch-smoke.ts:553	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/unattended-dispatch-smoke.ts:555	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/usage-ledger-default-on-smoke.ts:19	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/usage-ledger-default-on-smoke.ts:244	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/usage-ledger-default-on-smoke.ts:357	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/usage-ledger-dispatch-smoke.ts:456	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/validation-protocol-smoke.ts:413	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/validation-protocol-smoke.ts:1183	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/validation-protocol-smoke.ts:1184	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/validation-protocol-smoke.ts:1206	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/validation-protocol-smoke.ts:1209	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/validation-protocol-smoke.ts:1210	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/validation-protocol-smoke.ts:1223	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/validation-protocol-smoke.ts:1226	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/src/tasks/worktree-policy-smoke.ts:8	verification/test fixtures	migrate	Story 6 / verification-fixture classification
packages/main/templates/agents/lattice-evaluator.md:200	other tracked text	migrate	Story 4 / prompt classification
packages/main/templates/agents/lattice-review-behavior.md:104	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-channel.md:104	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-concept.md:104	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-delivery.md:152	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-delivery.md:154	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-delivery.md:161	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-delivery.md:248	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-docs.md:107	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-docs.md:117	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-docs.md:119	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-docs.md:136	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-docs.md:142	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-docs.md:165	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-docs.md:169	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-docs.md:178	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-quality.md:104	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-story-init.md:125	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-story-init.md:185	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-story-init.md:205	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-story-init.md:209	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-story-init.md:252	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/lattice-review-story-init.md:267	review/preflight/prompts	migrate	Story 4 / bounded review routing
packages/main/templates/agents/test-intent.md:80	review/preflight/prompts	migrate	Story 4 / bounded review routing
scripts/verify-codex-assets.mjs:80	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-codex-assets.mjs:94	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-codex-assets.mjs:95	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-codex-assets.mjs:96	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-codex-assets.mjs:97	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-codex-assets.mjs:124	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-dev-memory.mjs:781	verification/test fixtures	migrate	Story 6 / verification-fixture classification
scripts/verify-dev-memory.mjs:801	verification/test fixtures	migrate	Story 6 / verification-fixture classification
scripts/verify-entrypoints.mjs:99	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:137	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:142	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:152	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:157	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:164	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:178	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:179	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:182	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:184	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:189	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:196	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:398	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:399	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:400	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:401	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:515	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:516	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:517	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:522	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:527	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:529	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:534	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:565	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:568	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:569	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:580	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:726	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:727	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:731	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:732	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:733	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:734	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:735	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:736	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:747	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:766	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:768	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:784	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:786	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:800	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:802	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:803	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:819	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:820	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:821	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:822	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:825	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:826	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:827	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:828	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:842	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:843	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:844	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:848	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:849	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:850	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:851	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:852	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:853	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:854	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:855	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:856	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:857	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:858	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:859	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:860	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:861	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:870	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:871	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:872	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:873	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:874	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:875	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:878	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:879	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:880	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:881	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:882	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-entrypoints.mjs:883	verification/test fixtures	migrate	Stories 6-7 / entrypoint verification
scripts/verify-process-fact-contract.mjs:54	verification/test fixtures	migrate	Story 6 / process-fact verifier
scripts/verify-process-fact-contract.mjs:423	verification/test fixtures	migrate	Story 6 / process-fact verifier
scripts/verify-process-fact-contract.mjs:428	verification/test fixtures	migrate	Story 6 / process-fact verifier
scripts/verify-proof-or-stop-prompt-baseline.mjs:132	verification/test fixtures	migrate	Story 5 / retired-authority guard
```

</details>
