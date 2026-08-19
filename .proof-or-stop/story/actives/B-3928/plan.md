# B-3928 Plan - M0 Proof-or-Stop Prompt Baseline Inventory And Lockfile

## Scope Boundary

This story implements only M0 from docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md. It records current prompt facts, creates a deterministic baseline/overlap matrix, and adds focused regression checks. It does not edit package prompt bodies, Claude/Codex mirrored prompt bodies, role names, lifecycle gates, or runtime prompt routing semantics.

## Shared Verification Command

Primary focused verification: node scripts/verify-proof-or-stop-prompt-baseline.mjs. The script must report PASS with roleCount=16, registry baseline verified, agent_prompt output hashes verified, overlap matrix verified, legacy vocabulary findings classified, and direct docs/story write findings classified.

## CHK-001 - Record the 16 prompt filenames and template hashes

Implement a committed baseline JSON under docs/requirements/baselines/ that is generated from the built prompt registry, including schema version, registry materialHash, role count, role IDs, filenames, relative paths, template bytes, and templateHash values. The verifier recomputes promptRegistryManifest/readPromptRegistry data and fails if roles or hashes drift without an intentional baseline update.

## CHK-002 - Capture agent_prompt output for every role as comparison artifacts

Extend the same baseline to store comparison metadata for lattice agent_prompt output per role: output hash, byte count, and line count. The verifier must invoke or faithfully exercise the same CLI path and fail if any registry role cannot be fetched or if output differs from the committed baseline.

## CHK-003 - Produce a role-overlap matrix for all 16 prompts

Create docs/requirements/baselines/proof-or-stop-prompt-overlap-matrix.md from the baseline role classification. The matrix must include each role's current status, purpose, phase, input, output artifact, command surface, capability summary, and overlap category so later consolidation work can see where responsibilities cross.

## CHK-004 - Add regression checks for legacy verification vocabulary in active prompts

Make the verifier scan prompt content for legacy verification terms such as testIntent, TEST_CASE, and TEST_CASE_REVIEW. Existing uses must be captured with role, line, term, and classification. The check fails on new unclassified uses, especially in active non-legacy roles without an explicit legacy/deprecation/context classification.

## CHK-005 - Add regression checks for direct story-file write instructions

Make the verifier scan prompt content for docs/story references and classify them as policy reminders, read-only references, process-event evidence references, direct reads, or direct writes. It must distinguish harmless negative policy reminders from actionable direct write instructions, and fail on new unregistered direct docs/story write instructions.

## Out Of Scope

- Rename roles to proof-or-stop-*.
- Edit packages/main/templates/agents/*.md prompt bodies.
- Edit .claude/agents/*.md or .lattice-codex/agents/*.md mirrors.
- Change lifecycle gates, reviewer routing, prompt registry semantics, or agent_prompt role normalization.
- Treat memory/playbook advisory data as gate evidence.
