# Plan — B-cee5 Stop high-token reviewer scans

Strategy: prompt-and-static-test stopgap only. Default reviewer flow = bounded memory/playbook preflight (advisory only) + candidateSpecSet-first routing; full decisions-directory content scans survive only behind a recorded scanEscalationReason. No lifecycle/gate/DONE semantic changes; memory stays gateEvidence=false.

## CHK-001 Confirm broad-scan token baseline and affected prompts

Re-measure in the worktree and record evidence:
- `find docs/requirements/decisions -name '*.md' | wc -l` plus `wc -w` / `wc -c` totals (expected ~111 files / ~319.6k words / ~2.4MB).
- `rg -n` the exact full-scan instructions: packages/main/templates/agents/lattice-review-scope-plan.md (lines ~122 "Always scan the **full decisions/ directory**", ~158 "Every decisions/*.md file", ~191 "always defer to the full decisions/ directory") and packages/main/templates/agents/lattice-review-behavior.md (line ~126 "Spec boundary perspective (full directory scan of `<requirementsDir>/decisions/`)", ~160 "**all .md files under `<requirementsDir>/decisions/`**").
- Confirm mirrors (.claude/agents, .lattice-codex/agents) are byte-identical copies of the two templates before the change (diff), so the mirror-sync obligation in CHK-005 is grounded.
Bind evidence with verification_evidence_add using the literal commands run.

## CHK-002 Add bounded memory/playbook preflight requirement to broad-scan prompts

Edit both templates so the search strategy section starts with a mandatory bounded preflight step:
- Consume the session's Memory Runtime Preflight block when present; otherwise run `lattice dev_memory_preflight` / `lattice dev_memory_search --query=...` (bounded top-K) and `lattice playbook_runtime_health`-exposed active playbook advisory if available.
- State verbatim that memory/playbook output is ADVISORY ONLY, non-authoritative, gateEvidence=false, and can never satisfy or replace gate evidence; it may only order/seed the candidate search.
- Wording must not imply any new gate. Keep each template's added block compact (<25 lines) to protect the prompt token budget (templates are ~12KB; prompt-token-cost-smoke baseline gives 63KB headroom — verify with wc -c after edit).

## CHK-003 Replace default full decisions scan with candidateSpecSet-first routing

In lattice-review-scope-plan.md, replace the unconditional full-directory read with:
1. Enumerate decisions/ FILENAMES (cheap listing — enumeration stays complete so coverage checking remains sound).
2. Build candidateSpecSet from: checklist relatedDocs, story title/description/keywords/riskSignals, changed files/symbols, command/config names, `lattice aux_doc_list` output, and top-N `rg` keyword matches over decisions/ (N<=15 docs full-read budget).
3. Read full content ONLY for candidateSpecSet members; remaining files get filename/title-level triage only.
4. Full-content directory scan is allowed ONLY with a recorded scanEscalationReason (allowed triggers: high-risk lifecycle/gate change, process-fact change, global rename, candidate ambiguity, explicit reviewer escalation). The reason must be written into the review output.
Update the template frontmatter/description line ("checks checklist coverage against the full decisions/ spec directory") to describe candidate-first routing while keeping the (B-ed3e S2) provenance tag. Keep the "relatedDocs alone is not authoritative" principle by REQUIRING the enumeration + keyword-match steps so candidateSpecSet is never just relatedDocs.

## CHK-004 Forbid REVIEW behavior from default full decisions scans

In lattice-review-behavior.md, rewrite the "Spec boundary perspective" step: default inputs become scope_check_save result (scope-plan already did coverage), current diff, story commitments/userSees, and transcript context, plus candidateSpecSet docs; drop the unconditional "full directory scan"/"all .md files" wording (line ~126 and the input-list line ~160). Full scan only under the same scanEscalationReason triggers, recorded in the review output. Keep the existing finding taxonomy (category=missing + "spec-boundary:" desc prefix) untouched.

## CHK-005 Synchronize materialized prompt assets if required

Mirrors are full materialized copies (verified identical pre-change). After template edits: sync .claude/agents/ and .lattice-codex/agents/ copies of both files — run `lattice check` to surface drift and `lattice check --apply` if it syncs agent assets; otherwise copy template content manually (the .lattice-codex variant substitutes `.claude/agents/` path references per prompt-registry.ts:172 — preserve that substitution). Post-condition: template vs .claude mirror diff is empty; .lattice-codex differs only by the known path substitution. No other prompt assets touched.

## CHK-006 Add static regression tests for broad-scan budget rules

New standalone smoke `packages/main/src/tasks/reviewer-scan-budget-guard-smoke.ts` modeled on retired-authority-vocabulary-guard-smoke.ts:
- Scans all six active prompt copies (2 templates + 2 .claude mirrors + 2 .lattice-codex mirrors).
- FAILS on unconditional broad-scan wording: /Always scan the .*full decisions/i, /read every decisions/i, /full directory scan of/i, /all \.md files under .*decisions/i — UNLESS the same line/section carries escalation wording (scanEscalationReason).
- FAILS if required phrases are missing: candidateSpecSet, scanEscalationReason, and the advisory-only/gateEvidence=false memory disclaimer in both roles.
- Wiring: the smoke must run inside `lattice validate`; that requires a one-line addition to lattice.config.json validate.commands, which is OUTSIDE the current execution-boundary allowedPaths. File `lattice scope_extension_proposal` for exactly that one-line wiring change and record the decision via scope_extension_decide before touching the file; if the extension is declined, the smoke still ships and is run explicitly via `node packages/main/dist/tasks/reviewer-scan-budget-guard-smoke.js` bound as story verification evidence.

## CHK-007 Verify prompt output and record expected token-savings evidence

- `npm --prefix packages/main run build`, then `lattice agent_prompt --role=lattice-review-scope-plan` and `--role=lattice-review-behavior`: assert rendered output contains the bounded-preflight + candidateSpecSet + scanEscalationReason wording and no unconditional full-scan instruction.
- Run the new smoke (green) and demonstrate the red path by grepping that old wording is absent from all six copies.
- Record before/after budget evidence: before = every scope-plan/behavior run reads 111 docs (~2.4MB) by instruction; after = default reads bounded preflight + <=15 candidate docs + filename triage, full scan only with recorded escalation. Bind all commands with verification_evidence_add (literal commands).
