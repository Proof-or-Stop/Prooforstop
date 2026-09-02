# AGENTS.md current-version audit

This artifact is the durable RED-to-GREEN record for Story B-d854. It binds the
pre-translation baseline to the corrected English guide and its rerunnable
verifier.

## Artifact binding

- Baseline git object: `219a567^:AGENTS.md`
- Baseline SHA-256: `57157149f8cd6acdc8abb00896c8b8dd838f06baffefed04e38b1e69535494e9`
- Final file: `AGENTS.md`
- Final SHA-256: `fa8df6daa294a3610f26ade2576e5312478cd9503fe1975d3000157854f0dc15`
- Baseline structural inventory digest: `be1e674381b72472da79db4e2d7038e26ad140083cce32b9ff606f9ff6b61f6d`
- Final structural inventory digest: `ae2a5830f98a3073fbea26eae23a1ca8e1518ebb0e9b1fdef6a44a1a95a839e7`
- Final normative-sentence digest: `5650ef93ae56c99e10d0c804328cb8cdb8d6ec7c05ddddbe5796e2c37dcb85dc`

Run one row with `node tests/AGENTS.verify.mjs --baseline --row=A01` or
`node tests/AGENTS.verify.mjs --final --row=A01`. Baseline rows deliberately
print RED and exit 1. Final rows print GREEN and exit 0. Run all final proof,
including command, structure, semantic, runtime, Unicode, and managed-template
checks, with `node tests/AGENTS.verify.mjs --final`.

## Claim-by-claim audit

| ID | Original baseline location and claim | RED command, salient output, exit | Authoritative source with exact lines | Final AGENTS section and claim | GREEN command, salient output, exit |
|---|---|---|---|---|---|
| A01 | `219a567^:AGENTS.md:1-14`: the managed marker wrapped the large local guide instead of the current global-thin template. | `node tests/AGENTS.verify.mjs --baseline --row=A01` -> `ROW A01 RED`; exit 1. | `packages/main/src/init-assets.ts:111-125`, `AGENTS_MD_GLOBAL_THIN_TEMPLATE`. | `Proof-or-Stop`: exact managed block, extended English guidance outside the markers. | `node tests/AGENTS.verify.mjs --final --row=A01` -> `ROW A01 GREEN`; exit 0. |
| A02 | `219a567^:AGENTS.md:25`: prohibited direct access under the obsolete `docs/story/` path. | Baseline row A02 -> RED; exit 1; stale path matched. | `proof-or-stop.config.json:7`, current `storyDir`. | `Working rules`: state path is `.proof-or-stop/story/actives`; mutations use CLI. | Final row A02 -> GREEN; exit 0. |
| A03 | `219a567^:AGENTS.md:26`: referenced a user-value section that did not exist. | Baseline row A03 -> RED; exit 1; dangling reference matched. | `packages/main/src/cli/command-catalog.ts:440-471`, current `userSees` and checklist contract. | `Working rules`: engineering and product completion are stated directly, without a dangling section. | Final row A03 -> GREEN; exit 0. |
| A04 | `219a567^:AGENTS.md:17`: claimed the global CLI had only core commands and auxiliary commands needed bootstrap. | Baseline row A04 -> RED; exit 1; obsolete core-only claim matched. | `packages/main/src/cli/command-catalog.ts:1327-1334`, registered `aux_doc_list`; repository-local help also lists the auxiliary family. | `Working rules`: registered repository-local `aux_*` commands are available. | Final row A04 -> GREEN; exit 0. |
| A05 | `219a567^:AGENTS.md:237-243`: Story creation example omitted the required four-section background. | Baseline row A05 -> RED; exit 1; incomplete example matched. | `packages/main/src/cli/command-catalog.ts:298` and `packages/main/src/handlers/story-create.ts:752-840`. | `Story creation and INIT` plus `Preserved current command examples`: background names, bounds, trigger identity, and a schema-valid example. | Final row A05 -> GREEN; exit 0. |
| A06 | `219a567^:AGENTS.md:237`: said a checklist-bearing Story stopped in PLAN. | Baseline row A06 -> RED; exit 1; stale PLAN claim matched. | `packages/main/src/handlers/story-create.ts:1124-1125`, normal creation stops in INIT. | `Story creation and INIT`: creation conservatively stops in INIT. | Final row A06 -> GREEN; exit 0. |
| A07 | `219a567^:AGENTS.md:243` and `:106-114`: contradictory worktree timing included a PLAN-to-DEV creation claim. | Baseline row A07 -> RED; exit 1; contradictory timing condition held. | `packages/main/src/core/lifecycle-registry.ts:142-161`, INIT to INIT_CHECK effect and PLAN cwd gate. | `INIT_CHECK and worktrees`: INIT to INIT_CHECK creates the worktree; entering PLAN enforces cwd. | Final row A07 -> GREEN; exit 0. |
| A08 | `219a567^:AGENTS.md:142-145`: said owner lease, takeover UX, and session rendering were not implemented. | Baseline row A08 -> RED; exit 1; unimplemented claim matched. | `packages/main/src/cli-engine.ts:531` and `:1412-1446`, takeover fields and lease gate. | `Session ownership and write coordination`: implemented lease plus stale/forced takeover boundaries. | Final row A08 -> GREEN; exit 0. |
| A09 | `219a567^:AGENTS.md:79-89`: described INIT_CHECK as automatic CLI work without both reviewers or six artifacts. | Baseline row A09 -> RED; exit 1; automatic-only table matched. | `packages/main/src/core/init-check-gate.ts:59-118` and `packages/main/src/core/lifecycle-registry.ts:142-149`. | `Story creation and INIT`: both independent reviewers, all six artifacts, `init_preflight`, and controlled `init_check_repair` fallback. | Final row A09 -> GREEN; exit 0. |
| A10 | `219a567^:AGENTS.md:252-254,438-473,559`: runnable examples used removed conversational test-intent mutations. | Baseline row A10 -> RED; exit 1; retired identifiers matched. | `packages/main/src/cli/command-catalog.ts:421-424`, current handoff command; the removed mutations are absent from `MAIN_TOOLS`. | `Codex, Claude, and subagent assets`: current verification-intent flow; retired mutations are unavailable and not runnable. | Final row A10 -> GREEN; exit 0. |
| A11 | `219a567^:AGENTS.md:484`: required total issue count to be zero. | Baseline row A11 -> RED; exit 1; zero-total criterion matched. | `packages/main/src/handlers/story-review.ts:635-706`, advisories remain issues while `blockerCount` is computed separately. | `PLAN artifacts and gate`: `blockerCount` is zero; advisories may remain. | Final row A11 -> GREEN; exit 0. |
| A12 | `219a567^:AGENTS.md:73-75`: named a quick skip without its bounded eligibility or remaining gates. | Baseline row A12 -> RED; exit 1; unbounded quick wording matched. | `packages/main/src/core/machine.ts:753-757` and `:1275-1348`, quick-path and gate checks. | `PLAN artifacts and gate`: optional only when CLI-eligible; scope, intent, ownership, memory, and policy still apply. | Final row A12 -> GREEN; exit 0. |
| A13 | `219a567^:AGENTS.md:237,297-311`: described checklist creation as title and context only. | Baseline row A13 -> RED; exit 1; narrow-field claim matched. | `packages/main/src/cli/command-catalog.ts:245-298` and `:440-471`. | `Story creation and INIT` and `PLAN artifacts and gate`: current `relatedDocs`, `userSees`, `excludes`, files, and intent fields. | Final row A13 -> GREEN; exit 0. |
| A14 | `219a567^:AGENTS.md:569-572`: instructed agents to fix all nearby and infrastructure defects in the current Story. | Baseline row A14 -> RED; exit 1; unbounded-scope wording matched. | User rule recorded on 2026-09-02 for B-d854; this is the controlling scope instruction. | `Defect triage and bounded scope`: blocking/high defects now; evidenced medium/low nonblockers deferred with ownership. | Final row A14 -> GREEN; exit 0. |
| A15 | `219a567^:AGENTS.md:63`: required every pass to point at the latest lane run. | Baseline row A15 -> RED; exit 1; latest-only pass claim matched. | `packages/main/src/core/review-run.ts:1444-1461`, non-latest current-round fresh PASS is allowed; findings retain latest-run rejection. | `Two-layer process-fact contract`: exact PASS/finding nuance. | Final row A15 -> GREEN; exit 0. |
| A16 | `219a567^:AGENTS.md:260-263`: showed caller-authored executable evidence through `checklist_update`. | Baseline row A16 -> RED; exit 1; raw evidence pattern matched. | `packages/main/src/handlers/checklist.ts:574-619` and `:1774-1879`, tool-owned execution and receipt path. | `DEV and checklist discipline`: immutable command/selector pin, actual execution, derived result, and receipt. | Final row A16 -> GREEN; exit 0. |
| A17 | `219a567^:AGENTS.md:207-222`: described prompt files and Bash without current dispatch target cardinality. | Baseline row A17 -> RED; exit 1; current dispatch claim absent. | `packages/main/src/core/agent-dispatch-registry.ts:45-115`. | `REVIEW and independent agents`: `dispatch` validates registered role and story/item/finding/cluster target. | Final row A17 -> GREEN; exit 0. |
| A18 | `219a567^:AGENTS.md:207-222`: treated materialized local prompt files as the primary current model. | Baseline row A18 -> RED; exit 1; old prompt-path model matched. | `packages/main/src/handlers/agent-prompt.ts:5-12` and `packages/main/src/init-assets.ts:228`. | `REVIEW and independent agents`: `agent_prompt` returns canonical registry render and body-free reviewer bootstrap. | Final row A18 -> GREEN; exit 0. |
| A19 | `219a567^:AGENTS.md:79-89,161-169`: named coverage review but omitted current read-only reviewer launch planning. | Baseline row A19 -> RED; exit 1; current planner absent. | `packages/main/src/handlers/reviewer-batch.ts:32-40,141-165`. | `REVIEW and independent agents`: `reviewer_batch` is read-only and launches/writes nothing. | Final row A19 -> GREEN; exit 0. |
| A20 | `219a567^:AGENTS.md:161-169`: human/agent balance prose omitted current cross-host quorum prerequisites and drift behavior. | Baseline row A20 -> RED; exit 1; quorum claim absent. | `packages/main/src/cli/command-catalog.ts:3080-3096` and `packages/main/src/core/command-policy.ts:516`. | `REVIEW and independent agents`: status first, current passes required, valid standing quorum and prompt-envelope distinction. | Final row A20 -> GREEN; exit 0. |
| A21 | `219a567^:AGENTS.md:70-160`: lifecycle prose mixed current, legacy, and incomplete gates. | Baseline row A21 -> RED; exit 1; the verifier treats the old unqualified lifecycle as RED. | `packages/main/src/core/lifecycle-registry.ts:142-230`, including DEV to REVIEW and REVIEW to TEST. | `Story lifecycle`: complete current phase table and phase-specific gate responsibilities. | Final row A21 -> GREEN; exit 0. |
| A22 | `219a567^:AGENTS.md:93-98,133-134`: treated porcelain dirtiness as one class and deferred metadata handling to a placeholder. | Baseline row A22 -> RED; exit 1; unclassified dirty rule matched. | `packages/main/src/handlers/done-prepare.ts:1157-1175,1844-1952,2253-2416`. | `Git cleanliness and drift classification`: consumer-specific material, Story, and metadata classifications. | Final row A22 -> GREEN; exit 0. |
| A23 | `219a567^:AGENTS.md:122`: required a manual patch bump after every runtime Story. | Baseline row A23 -> RED; exit 1; manual-bump instruction matched. | `packages/main/src/core/version-bump.ts:351-390`, DONE post-merge auto-bump and skip path. | `TEST and DONE`: DONE effect auto-bumps watched inputs and skips documentation-only work. | Final row A23 -> GREEN; exit 0. |
| A24 | `219a567^:AGENTS.md:133-134`: retained `B-9dfb once merged` as an unresolved future placeholder. | Baseline row A24 -> RED; exit 1; placeholder matched. | `packages/main/src/handlers/done-prepare.ts:287-300,2253-2416`, current clean-tree handling. | `Git cleanliness and drift classification`: current commands classify dirtiness; no future placeholder remains. | Final row A24 -> GREEN; exit 0. |
| A25 | `219a567^:AGENTS.md:388-394`: documented only two options or a one-option cons exception. | Baseline row A25 -> RED; exit 1; complete current empty-options exception absent. | `packages/main/src/handlers/decision.ts:53-69`, `options: []` rationale floor and one-option exclusion rule. | `PLAN artifacts and gate`: both current exceptions are stated exactly. | Final row A25 -> GREEN; exit 0. |
| A26 | `219a567^:AGENTS.md:276-280,493-565`: legacy runner examples omitted real-run confirmation and subagent guidance used old prompt conventions. | Baseline row A26 -> RED; exit 1; unsafe/old combination matched. | `packages/main/src/cli/command-catalog.ts:886-892`, `packages/main/src/core/command-policy.ts:243`, and current agent registry. | `Legacy fixture compatibility` plus `Codex, Claude, and subagent assets`: `--dryRun`, explicit `--confirm`, and host-orchestrated current agents. | Final row A26 -> GREEN; exit 0. |

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
- final fence markers: 24
- baseline table rows: 41; final table rows: 21
- baseline blockquotes: 11; final blockquotes: 0. Every baseline blockquote was
  either ordinary explanatory prose or the stale future placeholder accounted in
  A24; current content is rendered as normal prose.
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

The normative digest binds every prose sentence containing `must`, `must not`,
`never`, `only`, `current`, `legacy`, `advisory`, `blocking`, `phase`, `actor`, or
`authority`. The verifier must reject all four representative mutations:

- remote push prohibition inverted to permission;
- advisory status changed to mandatory blocking status;
- current/legacy qualifier erased;
- DEV-only implementation changed to every-phase permission.

The command case ledger extracts every exact lowercase `proof-or-stop` invocation
from Bash fences and inline code. Each full argv/payload is executed read-only,
validated by the built `MAIN_TOOLS` Zod schema, or explicitly classified as a
conceptual template. The unknown-command sentinel and malformed
`story_get --storyId` invocation must both exit nonzero.
