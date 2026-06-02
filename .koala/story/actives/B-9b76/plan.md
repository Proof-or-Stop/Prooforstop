# B-9b76 Plan - Registry Backed Thin Prompt Assets

## CHK-001 Document asset layering and compatibility contract

Update managed asset documentation to distinguish project-local required assets, package prompt registry assets, and generated/materialized prompt caches. Clarify that legacy .Codex/agents and .claude/agents remain supported, thin mode is opt-in, and safe sync rules still prevent overwriting local edits.

Verification: docs grep for registry-backed prompts, project-local required assets, legacy mirror compatibility, and no-overwrite migration guidance.

## CHK-002 Implement package prompt registry and host renderer

Add a core prompt registry that enumerates package template agents, computes stable hashes, and renders host-specific content for Claude and Codex. Keep existing renderCodexAgentContent behavior as the compatibility renderer. Do not change dispatch behavior unless necessary for read-only inspection.

Verification: node smoke test compares registry Claude output to templates and Codex output to existing render transform for every agent.

## CHK-003 Make Codex verification and managed asset checks registry-aware

Extend .Codex/koala.json with prompt mode metadata while preserving legacy mirror defaults. Update verify_codex so legacy mirror mode still hard-checks mirrors, and registry mode hard-checks registry version/hash/renderability instead of requiring local prompt copies. Update managed asset definitions so registry mode does not require prompt whole-file assets.

Verification: legacy Koala repo verify remains valid; thin fixture verify passes without .Codex/agents; mismatch fixture fails clearly.

## CHK-004 Add opt-in thin init asset mode

Add --asset-mode=full|thin to init. Full mode keeps current behavior. Thin mode writes host docs, launchers, manifest, and registry metadata while avoiding .Codex/agents copies. Keep default full for compatibility in this story unless tests prove a safe default switch.

Verification: init smoke in temporary projects checks full mode still materializes prompts, thin codex mode does not materialize .Codex/agents, and check/verify pass in both.

## CHK-005 Validate legacy compatibility and thin mode behavior

Run focused TypeScript build/tests and new smoke tasks covering prompt registry, init asset mode, managed assets, and Codex verification. Record verificationEvidence for each checklist item and run adapter verification after touching Codex surfaces.

Verification: npm build/test commands plus node bin/koala-codex.js verify_codex or equivalent local wrapper command pass, with notes about any skipped external heartbeat.
