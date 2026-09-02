# AGENTS.md current-version audit

This artifact is the durable RED-to-GREEN record for Story B-d854. It binds the
pre-translation baseline to the corrected English guide and its rerunnable
verifier.

## Artifact binding

- Baseline git object: `219a567^:AGENTS.md`
- Baseline SHA-256: `57157149f8cd6acdc8abb00896c8b8dd838f06baffefed04e38b1e69535494e9`
- Final file: `AGENTS.md`
- Final SHA-256: `8cb5db2aa56e94de108fc255d3a2b7f3ddc353b608c6d3aee1bf6f273ffd6a42`
- Baseline structural inventory digest: `be1e674381b72472da79db4e2d7038e26ad140083cce32b9ff606f9ff6b61f6d`
- Final structural inventory digest: `3cf17b530a1bbef51b0cee59dd3607425f689abc26a0f55504e7309bd489e908`
- Final complete-prose digest: `636f02ccb9eea88f5d6ef456e7679001d204a2ef83629aaf9b28eccd0209ab68`
- Immutable reviewed AGENTS SHA-256 in the verifier:
  `8cb5db2aa56e94de108fc255d3a2b7f3ddc353b608c6d3aee1bf6f273ffd6a42`

Run one row with `node tests/AGENTS.verify.mjs --baseline --row=A01` or
`node tests/AGENTS.verify.mjs --final --row=A01`. Baseline rows deliberately
print RED and exit 1. Final rows print GREEN and exit 0. Run all final proof,
including command, structure, semantic, runtime, Unicode, and managed-template
checks, with `node tests/AGENTS.verify.mjs --final`.

## Runtime evidence contexts

The initial audit recorded a repository-local invocation and canonical realpath
of `/Users/jek/Documents/GitHub/Prooforstop/.worktrees/B-d854/bin/proof-or-stop.js`
at `Proof-or-Stop 0.3.270`. Its global invocation was
`/opt/homebrew/bin/proof-or-stop`, whose canonical realpath was then
`/Users/jek/Documents/GitHub/Prooforstop/.worktrees/B-fe8f/packages/main/dist/cli.js`
at `Proof-or-Stop 0.3.271`. Those facts derive the historical classification
`VERSION_AND_REALPATH_DRIFT` and are bound by the tool-owned verification
receipt output digest
`8d66e8eae81c7be7326397a8c80b60a123bf1fabf1abfedb75d3cac2a5927748`.

That historical classification is not a claim about every later run. The
verifier separately resolves both paths and versions on each run and prints a
live `currentClassification`; the historical marker is always labeled
`context=initial-audit` and also records the independently computed current
classification.

## Independent Claude CLI and Agy CLI provenance

These two external audits were read-only discovery inputs. They did not replace
the local source, built command catalog, per-command help, state machine, or gate
behavior: repository-local implementation remains the behavior authority. Raw
vendor findings were reconciled by the Story owner against local executable
evidence, so raw counts and supportable counts are intentionally reported
separately.

- Claude: `/opt/homebrew/bin/claude`, Claude Code 2.1.258, model
  `claude-opus-5`, session `3a540dc1-9ecd-45af-bafb-78845401177b`. The exact
  transcript is
  `/Users/jek/.claude/projects/-Users-jek-Documents-GitHub-Prooforstop--worktrees-B-d854/3a540dc1-9ecd-45af-bafb-78845401177b.jsonl`,
  SHA-256
  `1cd25e48b697df884252a65b08c9eda602e4ce5bd4f6b3ec537899588030b0f7`.
  Its first record contains the exact prompt: read-only, claim-by-claim coverage
  of the entire root guide; repository-local 0.3.270 CLI/source/help, lifecycle,
  gates, prompts/assets, config, examples, paths, versions, and translation were
  in scope. It inventoried 34/34 sections and 262 material claims. Its raw vendor
  verdict contained 33 raw FAIL findings (2 critical, 8 high, 12 medium, 11 low).
  Owner reconciliation retained 26 supportable findings, rejected or weakened
  5, and treated 2 as conditional. The transcript is machine-local and not
  repository-portable; its exact path plus content hash makes the available copy
  reproducible and tamper-evident.
- Agy: `/Users/jek/.local/bin/agy`, Agy CLI 1.1.23, conversation
  `f48bd033-f9a7-4198-8ad2-638be9d122ff`. The exact invocation was
  `agy --print "$(cat /tmp/B-d854-agy-agents-audit-prompt.txt)" --mode plan --sandbox --dangerously-skip-permissions --output-format json --print-timeout 10m`;
  it returned `SUCCESS` in 465.638154 seconds. The prompt SHA-256 was
  `6e022d8eebd7235a521f3a764e13ccf107ad8bdd889f0dfac5177624e35c121a`
  and required the same exhaustive read-only current-version, command, lifecycle,
  gate, adapter, and English/encoding audit. Exact captured JSON stdout is stored
  at ordinal 953 of
  `/Users/jek/.codex/sessions/2026/09/01/rollout-2026-09-01T23-50-54-01a05f2b-162b-7c42-b1c4-9ca08a0d6957.jsonl`.
  The immutable captured stdout is 38,164 bytes with SHA-256
  `b4e930f908b5723acdfc7c24538c5081baeaf05fc50aac03a986f1018cd7f7ed`.
  Agy returned 13 raw findings; owner reconciliation retained 11 supportable.
  The containing Codex transcript can continue growing, so its whole-file hash is
  deliberately not the identity; ordinal, byte length, and captured-string hash
  identify the immutable output. Availability is machine-local.

## Claim-by-claim audit

`M01` through `M24` are the original 24 major issues in their original order;
`L01` and `L02` are the two separately reported low-priority issues. Exactly one
mechanical row owns each source issue. A row may use multiple conjunctive stale
predicates, but no source issue is split or merged merely to reach a row count.

| ID | Source issue | Original baseline location and exact defect | RED command, salient output, exit | Authoritative source | Final AGENTS correction | GREEN command, salient output, exit |
|---|---|---|---|---|---|---|
| A01 | M01 | `:1-14`: managed marker wrapped the obsolete large guide. | `--baseline --row=A01` -> `ROW A01 RED sourceIssue=M01`; exit 1; obsolete managed heading matched. | `template:managed-global-thin-template` -> `packages/main/src/init-assets.ts:111` | Managed block exactly matches the current global-thin template. | `--final --row=A01` -> GREEN; exit 0. |
| A02 | M02 | `:26`: prohibited the obsolete `docs/story/` path. | Row A02 RED; exact obsolete target matched; exit 1. | `config:canonical-story-directory` -> `proof-or-stop.config.json:7` | Canonical Story storage is `.proof-or-stop/story/actives`. | Row A02 GREEN; exit 0. |
| A03 | M03 | `:27`: dangling user-value acceptance section reference. | Row A03 RED; reference matched; exit 1. | `interface:checklist-user-visible-result-field` -> `packages/main/src/cli/command-catalog.ts:258` | The current checklist interface exposes `userSees` as the observable-result field. | Row A03 GREEN; exit 0. |
| A04 | M04 | `:18,295`: global CLI described as core-only and aux as bootstrap-only. | Row A04 RED; core-only predicate matched; exit 1. | `interface:core-aux-doc-list-registration` -> `packages/main/src/cli/command-catalog.ts:1327`; `interface:utils-aux-diagnose-registration` -> `packages/utils/src/tool-defs.ts:11`; `interface:utils-aux-trace-registration` -> `packages/utils/src/tool-defs.ts:15`; `interface:utils-aux-scan-registration` -> `packages/utils/src/tool-defs.ts:20`; `interface:utils-aux-detail-registration` -> `packages/utils/src/tool-defs.ts:25`; `interface:utils-aux-sync-registration` -> `packages/utils/src/tool-defs.ts:28`; `interface:utils-aux-coverage-registration` -> `packages/utils/src/tool-defs.ts:31`; `interface:utils-aux-locate-registration` -> `packages/utils/src/tool-defs.ts:34` | Repository-local registration covers core `aux_doc_list` plus utils `aux_diagnose`, `aux_trace`, `aux_scan`, `aux_detail`, `aux_sync`, `aux_coverage`, and `aux_locate`. | Row A04 GREEN; exit 0. |
| A05 | M05 | `:237-238`: `story_create` example lacks required four-section background. | Row A05 RED; incomplete invocation present and background absent; exit 1. | `runtime:story-create-background-required-guard` -> `packages/main/src/handlers/story-create.ts:825`; `runtime:story-create-background-validator-call` -> `packages/main/src/handlers/story-create.ts:833`; `policy:background-canonical-section-set` -> `packages/main/src/core/background-validator.ts:15`; `runtime:background-total-length-guard` -> `packages/main/src/core/background-validator.ts:125`; `runtime:background-section-length-guard` -> `packages/main/src/core/background-validator.ts:149`; `runtime:background-trigger-identifier-guard` -> `packages/main/src/core/background-validator.ts:157` | `story_create` requires background and invokes validation for the canonical four sections, 300-character total, 50-character sections, and trigger identifier. | Row A05 GREEN; exit 0. |
| A06 | M06 | `:238`: checklist `title`/`context` values are CJK although authoring rejects CJK before persistence. | Row A06 RED; exact CJK payload pair matched; exit 1. | `runtime:story-create-draft-english-authoring-guard` -> `packages/main/src/handlers/story-create.ts:603`; `runtime:story-create-normal-english-authoring-guard` -> `packages/main/src/handlers/story-create.ts:750` | Draft and normal `story_create` paths both invoke the English-authoring guard; the example is English. | Row A06 GREEN; exit 0. |
| A07 | M07 | `:237`: checklist-bearing creation said it stops in PLAN. | Row A07 RED; exact stale PLAN comment matched; exit 1. | `runtime:story-create-normal-initial-phase` -> `packages/main/src/handlers/story-create.ts:1125` | Checklist-bearing normal creation selects INIT, not PLAN. | Row A07 GREEN; exit 0. |
| A08 | M08 | `:243`: PLAN to DEV said to create the worktree. | Row A08 RED; exact transition claim matched; exit 1. | `policy:init-check-worktree-create-effect` -> `packages/main/src/core/lifecycle-registry.ts:145`; `policy:plan-entry-cwd-worktree-gate` -> `packages/main/src/core/lifecycle-registry.ts:154` | INIT to INIT_CHECK owns worktree creation; INIT_CHECK to PLAN owns the cwd gate. | Row A08 GREEN; exit 0. |
| A09 | M09 | `:84`: INIT_CHECK described as automatic CLI work, omitting reviewers and six artifacts. | Row A09 RED; exact table cell matched; exit 1. | `policy:init-check-required-reviewer-pair` -> `packages/main/src/core/init-check-gate.ts:59`; `policy:init-check-six-transition-gates` -> `packages/main/src/core/lifecycle-registry.ts:144`; `interface:init-preflight-command-registration` -> `packages/main/src/cli/command-catalog.ts:1098`; `runtime:init-preflight-read-only-boundary-call` -> `packages/main/src/handlers/init-preflight.ts:321`; `runtime:init-repair-explicit-acknowledgement-guard` -> `packages/main/src/handlers/init-check.ts:289`; `runtime:init-repair-substantive-reason-guard` -> `packages/main/src/handlers/init-check.ts:296` | INIT_CHECK requires both reviewer roles and six transition gates; `init_preflight` is registered with a runtime read-only boundary, while repair requires explicit acknowledgement and a substantive reason. | Row A09 GREEN; exit 0. |
| A10 | M10 | `:144`: owner lease/takeover/session rendering called unimplemented. | Row A10 RED; unimplemented predicate matched; exit 1. | `runtime:owner-lease-cli-enforcement-choke-point` -> `packages/main/src/cli-engine.ts:1430`; `runtime:owner-lease-acquire-or-refresh-flow` -> `packages/main/src/core/story-owner-lease.ts:363`; `runtime:active-lease-force-takeover-guard` -> `packages/main/src/core/story-owner-lease.ts:784`; `runtime:takeover-owner-lease-write` -> `packages/main/src/core/story-owner-lease.ts:802`; `runtime:session-brief-ownership-renderer` -> `packages/main/src/handlers/session.ts:534` | Runtime enforces owner leases, acquire/refresh, stale-versus-force takeover, transfer writes, and `session_brief` ownership rendering. | Row A10 GREEN; exit 0. |
| A11 | M11 | `:253,443,457,461`: retired `testintent_record`/`testintent_resume` are runnable. | Row A11 RED; retired identifier matched; exit 1. | `interface:current-intent-handoff-registration` -> `packages/main/src/cli/command-catalog.ts:421` | Current runnable guidance uses the registered `testintent_handoff`; retired mutation examples were removed. | Row A11 GREEN; exit 0. |
| A12 | M12 | `:484`: PLAN acceptance requires `issueCount=0`. | Row A12 RED; exact criterion matched; exit 1. | `runtime:plan-review-blocker-count` -> `packages/main/src/handlers/story-review.ts:698` | PLAN review acceptance uses zero blockers, not zero total issues. | Row A12 GREEN; exit 0. |
| A13 | M13 | `:484`: `story_review` stated as unconditional. | Row A13 RED; exact mandatory sentence matched; exit 1. | `runtime:quick-path-eligibility-guard` -> `packages/main/src/core/machine.ts:753` | Quick-path review optionality exists only when runtime policy enables the quick path. | Row A13 GREEN; exit 0. |
| A14 | M14 | `:484-490`: PLAN-to-DEV guide lists only intent review and omits scope evidence/current gates. | Row A14 RED; old checklist present and `scope-check.json` absent; exit 1. | `runtime:scope-check-signature-mint` -> `packages/main/src/handlers/scope-check.ts:239`; `runtime:scope-check-persistence` -> `packages/main/src/handlers/scope-check.ts:259`; `interface:scope-question-resolution-registration` -> `packages/main/src/cli/command-catalog.ts:2470`; `runtime:scope-open-question-resolution-gate` -> `packages/main/src/handlers/story-review.ts:665`; `runtime:plan-to-dev-scope-contract-advisory` -> `packages/main/src/handlers/phase-gates.ts:546`; `runtime:review-scope-contract-missing-block` -> `packages/main/src/handlers/phase-gates.ts:501` | Runtime signs and persists scope checks, gates unresolved questions, advises on missing contracts at PLAN-to-DEV, and blocks a missing new-scope contract at REVIEW. | Row A14 GREEN; exit 0. |
| A15 | M15 | `:237,309`: main agent fields limited to title/context/relatedDocs. | Row A15 RED; exact limitation matched; exit 1. | `interface:checklist-title-context-related-docs-fields` -> `packages/main/src/cli/command-catalog.ts:254`; `interface:checklist-user-sees-field` -> `packages/main/src/cli/command-catalog.ts:258`; `interface:checklist-excludes-field` -> `packages/main/src/cli/command-catalog.ts:259`; `interface:checklist-affected-files-field` -> `packages/main/src/cli/command-catalog.ts:260`; `interface:checklist-verification-intent-field` -> `packages/main/src/cli/command-catalog.ts:265` | Checklist authoring exposes title/context/related docs, `userSees`, `excludes`, affected files, and verification intent. | Row A15 GREEN; exit 0. |
| A16 | M16 | `:571-572`: ordered all nearby/infrastructure defects into the current Story. | Row A16 RED; both unbounded predicates matched; exit 1. | `policy:bounded-defect-triage-policy` -> `AGENTS.md:66` | The user-approved bounded defect-triage policy replaces unbounded nearby repair. | Row A16 GREEN; exit 0. |
| A17 | M17 | `:63`: every PASS/finding required the latest lane run. | Row A17 RED; latest-run predicate matched; exit 1. | `runtime:nonlatest-pass-latest-finding-branch` -> `packages/main/src/core/review-run.ts:1455` | Runtime exempts passes, but not findings, from the latest-run rejection branch. | Row A17 GREEN; exit 0. |
| A18 | M18 | `:263`: caller-authored executable evidence through `checklist_update`. | Row A18 RED; exact raw evidence form matched; exit 1. | `runtime:pinned-verification-command-execution` -> `packages/main/src/handlers/checklist.ts:767`; `runtime:tool-owned-verification-receipt-mint` -> `packages/main/src/handlers/checklist.ts:812` | Runtime executes the pinned command and mints the tool-owned receipt. | Row A18 GREEN; exit 0. |
| A19 | M19 | `:207-221`: legacy Bash/prompt model omitted dispatch, agent prompt, roster/batch, lane opt-in/quorum surfaces. | Row A19 RED; legacy model present and all four current entrypoints absent; exit 1. | `policy:dispatch-implementer-role-registry` -> `packages/main/src/core/agent-dispatch-registry.ts:22`; `policy:dispatch-implementer-target-cardinality` -> `packages/main/src/core/agent-dispatch-registry.ts:26`; `interface:dispatch-command-registration` -> `packages/main/src/cli/command-catalog.ts:2479`; `runtime:dispatch-registry-request-validation` -> `packages/main/src/handlers/story-dispatch.ts:898`; `runtime:canonical-agent-prompt-render` -> `packages/main/src/handlers/agent-prompt.ts:140`; `runtime:reviewer-list-policy-roster-computation` -> `packages/main/src/handlers/reviewer-list.ts:210`; `runtime:reviewer-batch-shared-roster-computation` -> `packages/main/src/handlers/reviewer-batch.ts:303`; `runtime:reviewer-batch-side-effect-flag-guard` -> `packages/main/src/handlers/reviewer-batch.ts:149`; `runtime:reviewer-batch-boundary-invocation` -> `packages/main/src/handlers/reviewer-batch.ts:263`; `runtime:reviewer-batch-host-instruction-builder` -> `packages/main/src/handlers/reviewer-batch.ts:178`; `runtime:reviewer-batch-host-instruction-use` -> `packages/main/src/handlers/reviewer-batch.ts:331`; `interface:review-run-start-registration` -> `packages/main/src/cli/command-catalog.ts:655`; `interface:review-pass-registration` -> `packages/main/src/cli/command-catalog.ts:669`; `interface:review-pass-run-id-schema` -> `packages/main/src/cli/command-catalog.ts:672`; `runtime:review-pass-current-run-enforcement` -> `packages/main/src/handlers/finding.ts:360`; `interface:reviewer-finding-registration` -> `packages/main/src/cli/command-catalog.ts:2074`; `interface:reviewer-finding-run-id-schema` -> `packages/main/src/cli/command-catalog.ts:2089`; `runtime:reviewer-finding-lane-detection` -> `packages/main/src/handlers/finding.ts:519`; `runtime:reviewer-finding-current-run-enforcement` -> `packages/main/src/handlers/finding.ts:523`; `interface:quorum-submit-registration` -> `packages/main/src/cli/command-catalog.ts:3080`; `runtime:quorum-required-reviewer-pass-validation` -> `packages/main/src/handlers/quorum-submit.ts:144`; `runtime:quorum-reviewer-pass-validation-call` -> `packages/main/src/handlers/quorum-submit.ts:444` | Dispatch registry/cardinality, prompt render, policy rosters, batch read-only enforcement and host instructions, signed run/pass/finding interfaces plus runtime checks, and quorum pass validation are partitioned explicitly. | Row A19 GREEN; exit 0. |
| A20 | M20 | `:79-160`: DEV/REVIEW/TEST/DONE gate description was materially incomplete. | Row A20 RED; old TEST account present while the current acceptance-topology and delivery-check entrypoints are absent; exit 1. | `runtime:review-entry-verification-evidence-gate` -> `packages/main/src/core/machine.ts:1388`; `runtime:done-open-bug-gate` -> `packages/main/src/core/machine.ts:1422`; `runtime:test-entry-review-verdict-gate` -> `packages/main/src/core/machine.ts:1409`; `runtime:proofstory-review-completeness-evaluation` -> `packages/main/src/handlers/phase-gates.ts:389`; `runtime:plan-acceptance-topology-evaluation` -> `packages/main/src/handlers/transition-orchestrator.ts:985`; `runtime:done-delivery-freshness-evaluation` -> `packages/main/src/core/machine.ts:953`; `runtime:done-policy-summary-requirement` -> `packages/main/src/core/done-oracle.ts:932` | Runtime separately gates verification evidence, open bugs, review verdict, ProofStory completeness, acceptance topology, delivery freshness, and policy-aware summary. | Row A20 GREEN; exit 0. |
| A21 | M21 | `:95-98,133-134`: any porcelain dirtiness was treated as one blocker while metadata-only handling was deferred to a future placeholder. | Row A21 RED; universal commit-first rule and exact metadata-only future placeholder both present; exit 1. | `runtime:dirty-row-canonical-classification-call` -> `packages/main/src/handlers/done-prepare.ts:398`; `runtime:done-prepare-classified-blocker-consumption` -> `packages/main/src/handlers/done-prepare.ts:1837` | `done_prepare` classifies dirty rows through the canonical classifier before consuming its blocker set. | Row A21 GREEN; exit 0. |
| A22 | M22 | `:122`: required manual patch bump after merge. | Row A22 RED; manual-bump predicate matched; exit 1. | `runtime:done-watched-input-change-decision` -> `packages/main/src/handlers/done-effects.ts:1247`; `runtime:done-version-bump-effect-call` -> `packages/main/src/handlers/done-effects.ts:1248`; `runtime:version-bump-no-watched-input-skip` -> `packages/main/src/core/version-bump.ts:362`; `runtime:version-bump-git-commit` -> `packages/main/src/core/version-bump.ts:384` | DONE derives the watched-input decision, calls the bump effect, skips when false, and commits synchronized version changes when true. | Row A22 GREEN; exit 0. |
| A23 | M23 | `:134`: unresolved `B-9dfb once merged` placeholder. | Row A23 RED; exact placeholder matched; exit 1. | `runtime:done-clean-tree-closeout-call` -> `packages/main/src/handlers/done-prepare.ts:2253` | Current `done_prepare` invokes the clean-tree closeout; the future placeholder is removed. | Row A23 GREEN; exit 0. |
| A24 | M24 | `:390`: decision options documented only as two or one. | Row A24 RED; old rule present and empty-options exit absent; exit 1. | `runtime:decision-empty-options-branch` -> `packages/main/src/handlers/decision.ts:53`; `runtime:decision-empty-options-rationale-guard` -> `packages/main/src/handlers/decision.ts:58`; `runtime:decision-single-option-branch` -> `packages/main/src/handlers/decision.ts:63`; `runtime:decision-single-option-cons-guard` -> `packages/main/src/handlers/decision.ts:66` | Runtime has distinct empty-options and single-option branches with their respective rationale and cons guards. | Row A24 GREEN; exit 0. |
| A25 | L01 | `:278`: destructive `test_auto` shown bare, without confirmation. | Row A25 RED; exact bare command present and confirmed form absent; exit 1. | `runtime:test-auto-dry-run-preview-branch` -> `packages/main/src/handlers/test-auto.ts:68`; `runtime:test-auto-confirmation-guard` -> `packages/main/src/handlers/test-auto.ts:99` | Runtime provides a dry-run preview and rejects real execution without confirmation. | Row A25 GREEN; exit 0. |
| A26 | L02 | `:207-219,564`: legacy materialized Markdown/frontmatter reviewer prompt is taught as current. | Row A26 RED; prompt directory, `test-case-reviewer`, and `model: sonnet` all matched; exit 1. | `runtime:modern-agent-prompt-host-render` -> `packages/main/src/handlers/agent-prompt.ts:140`; `template:thin-adapter-package-prompt-registry` -> `packages/main/src/init-assets.ts:228`; `runtime:modern-host-launch-instruction-builder` -> `packages/main/src/handlers/reviewer-batch.ts:178`; `runtime:modern-host-launch-instruction-use` -> `packages/main/src/handlers/reviewer-batch.ts:331`; `policy:legacy-verification-role-alias-map` -> `packages/main/src/core/agent-dispatch-registry.ts:37` | Current prompt rendering, thin registry mode, host instruction generation/use, and legacy alias mapping replace the old frontmatter model. | Row A26 GREEN; exit 0. |

## Structural translation accounting

The rewrite translated current meaning, corrected stale behavior, and consolidated
repetition. Nothing below is an unrecorded deletion. Baseline line ranges are
stable because they come from the bound git object.

| Baseline lines | Baseline subject | Final location or explicit disposition |
|---|---|---|
| 14-28 | Operating rules | Translated into `Working rules`; the dangling user-value reference was replaced by a complete sentence, and read/write policy was corrected. |
| 29-45 | Project configuration | Translated into `Project configuration`; invalid JSON comments were removed and the example is explicitly abbreviated. |
| 46-54 | Data, logic, rendering architecture | Translated into `Architecture`. |
| 55-69 | Two-layer process-fact contract | Translated and updated in `Two-layer process-fact contract`; current registries and scripts remain named. |
| 70-78 | Lifecycle diagram and hints | Translated into the current lifecycle opening and `Story lifecycle`. The unbounded quick-skip label was qualified. |
| 79-92 | Phase/actor table | Translated and expanded into the current phase table. |
| 93-99 | Git-clean gate | Consolidated into `Git cleanliness and drift classification` and DEV commit discipline. |
| 100-141 | Worktree, remote, version, convergence, adapter, DONE | Split across `INIT_CHECK and worktrees`, ownership, REVIEW, and TEST/DONE. Manual bump and future-placeholder claims were corrected. |
| 142-145 | Multi-session coordination | Translated into `Session ownership and write coordination`; implemented lease behavior replaced the stale rollout claim. |
| 146-160 | TEST flow | Translated into `TEST and DONE`; legacy runners remain explicitly compatibility-only. |
| 161-170 | Three-party balance | Translated into `REVIEW and independent agents`; current dispatch, passes, and human arbitration replace generic prose. |
| 171-206 | Finding evidence states and gap logging | Translated under REVIEW without a duplicate heading; current blocking and deferral semantics are preserved. |
| 207-222 | Subagent prompt definition | Replaced by the current registry/body-free/host-orchestrated model under `Codex, Claude, and subagent assets`. The old Markdown-frontmatter example is historical, not current runtime guidance. |
| 223-296 | CLI quick reference | Consolidated into `CLI usage` and `Preserved current command examples`. All 14 still-current removed examples were restored: `aux_detail`, `aux_diagnose`, `aux_scan`, `aux_sync`, `aux_trace`, `decision_get`, `decision_set`, `fixture_batch_add`, `gap_log`, `story_create`, `test_fixture`, `test_story`, `understanding_get`, and `understanding_set`. |
| 297-311 | Checklist shape | Translated and expanded in `PLAN artifacts and gate` with current fields. |
| 312-321 | Related-document reminders | Consolidated into the `relatedDocs` paragraph; reminders remain advisory and are not an acknowledgement gate. |
| 322-336 | Understanding snapshot | Translated into `PLAN artifacts and gate`; touchpoints are correctly limited to material Story files. |
| 337-351 | High-risk keyword list | Consolidated into source-driven Story creation guidance. The duplicated hard-coded keyword list was intentionally not copied because the current handler is authoritative and can change. |
| 352-366 | Duplicate Story detection constants | Consolidated into source-driven deduplication guidance. Exact implementation windows and keyword constants were intentionally not duplicated. |
| 367-397 | Structured decision | Translated and corrected in `PLAN artifacts and gate`, including the current empty-options exit. |
| 398-423 | Legacy test-intent object schema | Removed from runnable guidance because new Stories use `verificationIntent`; compatibility role names remain explicitly identified. |
| 424-447 | Legacy results and conversational review | Replaced by signed `review_run_start`, findings, and reviewer passes. Removed mutation commands are not current commands. |
| 448-475 | Legacy review rollback and five-turn segment protocol | Consolidated into current lifecycle and review-loop guidance; the retired command transcript was intentionally removed. |
| 476-492 | Checklist splitting and adversarial review | Translated into current checklist fields, intent lanes, scope review, and blocker-count gate. |
| 493-544 | Fixture schema, variables, and chains | Translated and consolidated in `Legacy fixture compatibility`; fields, runner variables, ESM import, chain topology, and cleanup remain covered. |
| 545-565 | Common errors and pitfalls | Distributed into Working rules, DEV evidence discipline, and legacy fixture safety; obsolete conversational commands were removed. |
| 566-574 | Main-agent behavior | Translated into peer-review authority and bounded defect triage. The unbounded scope expansion rule was replaced by the user-approved policy. |
| 575-582 | Summary rules | Consolidated into Working rules, TEST/DONE, and legacy fixture compatibility. |
| 583-598 | Fail-fast caught-error policy | Faithfully translated into `Fail-fast policy for caught errors`. |

## Mechanical structural inventory

- baseline headings: 53
- final headings: 34
- baseline fence markers: 32
- final fence markers: 28
- baseline table rows: 41; final table rows: 21
- baseline blockquotes: 11; final blockquotes: 0. Every baseline blockquote was
  either ordinary explanatory prose or the stale future placeholder accounted in
  A23; current content is rendered as normal prose.
- baseline fence languages: `bash=5`, `json=7`, `markdown=1`, `plain=19`
- final fence languages: `bash=7`, `json=2`, `plain=12`, `text=3`
- HTML markers remain the current start/end pair.
- Both files contain no Markdown links. Paths, full command identifiers, role
  identifiers, JSON keys, phase tokens, and Story/checklist/finding tokens are all
  included in the bound inventory digests above.

The verifier rejects an in-memory replacement of
`scripts/verify-process-fact-contract.mjs` with `scripts/WRONG.mjs`, so aggregate
counts cannot hide a technical-token substitution.

## Semantic and command mutation proof

The complete-prose digest binds every non-code prose unit, not only sentences
selected by a normative-keyword allowlist. The verifier rejects all five
representative lifecycle/authority mutations:

- remote push prohibition inverted to permission;
- advisory status changed to mandatory blocking status;
- current/legacy qualifier erased;
- DEV-only implementation changed to every-phase permission.
- missing INIT reviewer evidence changed from never auto-invented to automatically
  invented.

The separate immutable reviewed-file SHA closes the mutable-audit loophole. Two
explicit probes refresh the in-memory audit SHA and still reject an ASCII Spanish
substitution and deletion of an ordinary baseline-derived architecture sentence.

The command case ledger extracts every exact lowercase `proof-or-stop` invocation
from Bash fences and inline code. Every real command, including conceptual
`aux_diagnose` and `test_fixture` examples, must resolve through its real `--help`;
payloads are additionally executed read-only or validated by the built
`MAIN_TOOLS` Zod schema. Dedicated unavailable-command mutations for both
conceptual examples, the unknown-command sentinel, and malformed
`story_get --storyId` invocation must all be rejected.
