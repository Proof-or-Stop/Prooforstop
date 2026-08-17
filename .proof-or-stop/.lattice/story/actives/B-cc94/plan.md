# Execution Plan: B-cc94 Playbook Runtime Memory MVP1

## Scope Boundary

This story implements MVP1 only: M0-M4 from docs/requirements/decisions/playbook-runtime-memory-consumption-execution-plan.md.

In scope:
- M0 red/repro proof for current session runtime non-consumption.
- M1 explicit active playbook activation boundary.
- M2 active-only runtime matcher on small fixtures.
- M3 MemoryFreshnessPack with source digests, stale classification, superseded suppression, 60-line render cap, gateEvidence:false, and authority:non_authoritative.
- M4 session_brief bounded advisory memory/playbook section.

Out of scope for this story:
- M5 handoff consumer.
- M6 story_create/story_advance lifecycle consumers.
- M7 DONE/final-response consumers.
- M8 capture-or-noop decision.
- M9-M10 1,000,000-record generator and verifier.
- M11 health/drift command.
- M12 rollout and multi-host verification.

## CHK-001 Add red/repro coverage for current non-consumption

**Owner**: main-agent

**Implementation**:
- Add a focused smoke fixture that seeds a dev-memory lesson, one active playbook, and one candidate playbook.
- The red/repro section must demonstrate the current gap separately from the candidate-inert contract: active guidance is absent from session_brief before the fix, while candidate playbooks remain inert by design.
- Capture the failing pre-fix expectation in ProofStory red evidence before claiming implementation success.

**Verify**:
- Focused smoke covers CHK-001:happy:0, CHK-001:edge:0, and CHK-001:adversarial:0.
- The red proof is linked to the later green smoke command rather than replaced by green evidence.

## CHK-002 Implement explicit active playbook activation boundary

**Owner**: main-agent

**Implementation**:
- Add a canonical playbook digest over the approved playbook domain.
- Add an explicit activation surface that moves candidate to active only when expectedPlaybookDigest matches current state.
- Keep candidate/stale/archived playbooks inert.
- Use shared write safety so activation cannot drop existing playbook rows.

**Verify**:
- Candidate without activation does not surface.
- Candidate activated with current digest surfaces.
- Stale digest, malformed playbook, and write drift fail closed.

## CHK-003 Implement runtime matcher and freshness pack core

**Owner**: main-agent

**Implementation**:
- Add a pure runtime matcher for active playbooks and dev-memory entries using bounded query/context inputs.
- Build MemoryFreshnessPack with project/global dev-memory, playbook, and signature registry digests.
- Suppress superseded dev-memory rows by default while recording suppressed IDs.
- Implement freshness checking with fresh, stale-relevant, and stale-irrelevant classification.
- Render packs with a hard 60-line cap and omittedCount.

**Verify**:
- Small noisy fixture finds expected active playbook and dev-memory IDs.
- Candidate/stale/archived playbooks never match.
- Relevant mutation is stale-relevant; unrelated append-only churn is not a blocking stale claim.
- Schema and output retain gateEvidence:false and authority:non_authoritative.

## CHK-004 Surface bounded memory/playbook pack in session_brief

**Owner**: main-agent

**Implementation**:
- Wire session_brief to call the runtime memory pack builder in a defensive try/catch.
- Render a bounded Memory Runtime Preflight section in full session_brief output.
- Preserve live lifecycle facts as the source of truth; memory render failures must never block session_brief.
- Include an explicit empty state when no relevant hits exist.

**Verify**:
- session_brief output includes Memory Runtime Preflight, active playbook IDs, dev-memory IDs, digest summary, gateEvidence:false, and non_authoritative wording.
- The render remains bounded and cannot flood terminal output.
- Corrupt or malformed advisory memory input cannot crash session_brief.

## CHK-005 Validate MVP1 and document remaining parent milestones

**Owner**: main-agent

**Implementation**:
- Run build and focused smoke commands.
- Record verificationEvidence for each checklist item.
- State clearly that M5-M12 remain open and are not delivered by MVP1.

**Verify**:
- npm --prefix packages/main run build passes.
- node packages/main/dist/tasks/playbook-runtime-memory-mvp1-smoke.js passes.
- Final summary does not claim handoff/story/DONE/1M baseline completion.
