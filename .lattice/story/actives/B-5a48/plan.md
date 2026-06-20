# Plan — B-5a48: wire Experience-Layer hints into the REVIEW loop

Approach: next-steps REVIEW hint surface + a single shared firing leaf. No new command. Advisory-only; the signed reviewer prompt hash (resolveReviewPromptHash) and review-run.ts stay untouched and byte-identical between A/B arms. OFF arm appends nothing.

## CHK-001 — shared firing leaf + behavior-preserving story-review.ts refactor
- Create `packages/main/src/core/experience-hint-surface.ts` exporting `surfaceExperienceHints(root, { storyId, hintRoundKey }): { hintMode, renderedSection, hintIds, fired }`.
  - Body is the CURRENT story-review.ts firing block (~610-649) moved VERBATIM: `hintMode = resolveHintMode(storyId)`; `const hints = loadExperienceHints(root)`; if `hasExperienceHints(hints)`, dedup-scan `readActivityLogTail(root, 1000)` for `event === 'experience_hint_surfaced' && storyId && reviewRound === hintRoundKey`; on miss `appendActivityLog({ timestamp, event:'experience_hint_surfaced', storyId, reviewRound: hintRoundKey, hintMode, hintIds: experienceHintIds(hints) })` (fires on BOTH arms; `fired=true` only when it appended); `renderedSection = hintMode === 'on' ? formatExperienceHintsSection(hints) : ''`.
  - try/catch around load+track, returning `renderedSection: ''` (preserve the existing console.warn-on-failure if present).
  - CRITICAL: the CALLER passes `hintRoundKey`; the leaf NEVER computes the `currentReviewRound || plan:<phase>` formula.
  - Imports ONLY `../core/experience-hint-loader.js`, `../core/hint-mode.js`, `../core/activity-log.js` (existing core leaves; zero new cross-layer edges).
- Refactor `packages/main/src/handlers/story-review.ts` to call `surfaceExperienceHints(ctx.root, { storyId: args.storyId, hintRoundKey })` (hintRoundKey still computed ~603 in the handler) and source `renderedHintsSection` from its result; `_reviewPrompt` assembly otherwise unchanged.
- VERIFY (CHK-001 intents): ON returns rendered section + 1 event; GOLDEN byte-equality of `_reviewPrompt` + event payload before/after on both arms; failure swallowed → empty section, no throw.

## CHK-002 — surface hints in buildNextSteps REVIEW branch (transition-effects.ts)
- In `packages/main/src/handlers/transition-effects.ts` REVIEW branch of `buildNextSteps`, AFTER the round-2 advisory block (~after 286, before `return base`), add an append-only try/catch:
  - `const story = store.readStory(storyId); const hintRoundKey = story.currentReviewRound || \`plan:${story.phase}\`;` (BYTE-IDENTICAL formula to story-review.ts ~603)
  - `const { renderedSection } = surfaceExperienceHints(root, { storyId, hintRoundKey }); if (renderedSection) base += \`\n${renderedSection}\`;`
  - Place AFTER the `Agent({ subagent_type: "lattice-review-*" })` launch lines so hints follow the reviewer-launch text.
  - Wrap the WHOLE block in `try { } catch { /* advisory-only: never block the transition */ }` (same posture as the existing round-2 advisory).
  - `import { surfaceExperienceHints } from '../core/experience-hint-surface.js'`.
  - Code comment: ADVISORY-ONLY (never fed to resolveReviewPromptHash, no gate reads it); OFF arm appends nothing → byte-identical; cross-site dedup via shared hintRoundKey; ordering dependency on transition-orchestrator persisting currentReviewRound BEFORE buildNextSteps.
- VERIFY (CHK-002 intents): ON-arm REVIEW guidance contains the section + 1 on-event; OFF-arm byte-identical + 1 off-event (lossless); a thrown error never blocks the transition; active-reviewer set unchanged.

## CHK-003 — smoke + invariants
- Add `packages/main/src/tasks/experience-layer-review-dispatch-hint-smoke.ts` (auto-discovered by run-all-smokes; mirror experience-layer-ab-shadow-gate-smoke.ts) asserting:
  - (a) ON-arm (sha256 first byte even) WITH signals → REVIEW text contains the section + exactly one experience_hint_surfaced(on) with full hintIds.
  - (b) OFF-arm → REVIEW text byte-identical to the no-hints baseline + exactly one event(off) with full hintIds.
  - (c) cross-site dedup: PLAN plan:<phase> event vs REVIEW ISO-key event disjoint; second buildNextSteps same round adds no event; REVIEW event.reviewRound == ISO currentReviewRound.
  - (d) INVARIANT: resolveReviewPromptHash / review-run output byte-identical ON vs OFF.
- Golden assertion (here or extend experience-layer-ab-shadow-gate-smoke.ts) for the CHK-001 leaf-extraction byte-equality.
- Add `package.json` alias `test:experience-layer-review-dispatch-hint`.
- Build (tsc) + run full smoke suite + lifecycle-registry-contract (must stay green WITHOUT edits — no new command).
- VERIFY (CHK-003 intents): smoke exits 0; npm test 0; lifecycle-registry-contract green untouched.
