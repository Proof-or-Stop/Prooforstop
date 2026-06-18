# Plan — B-06b3: Experience Layer ③.3 deterministic A/B hintMode + shadow-gated hints

Assign each story a deterministic hintMode (on/off) and gate the advisory experience-hints SECTION so reviewers see it only in the ON arm, while hints are still computed and the experience_hint_surfaced event fires (with hintMode) on BOTH arms. Hints stay advisory-only — no change to issues/blocker or resolveReviewPromptHash.

## CHK-001 — Pure resolveHintMode leaf
- New `packages/main/src/core/hint-mode.ts`, imports only `node:crypto`/types:
  - `export type HintMode = 'on' | 'off';`
  - `export function resolveHintMode(storyId: string): HintMode` — deterministic: `createHash('sha256').update(storyId).digest()`, take the first byte, `byte % 2 === 0 ? 'on' : 'off'`. Same storyId => same arm; roughly balanced. Tolerate empty string (still deterministic). Pure: no fs/git/time/random.

## CHK-002 — Shadow-gate the section render + record hintMode (story-review.ts)
- In `handlers/story-review.ts` experience-hints block (~551-578) and the `_reviewPrompt` IIFE:
  - `import { resolveHintMode } from '../core/hint-mode.js';`
  - Compute `const hintMode = resolveHintMode(args.storyId);` once.
  - Keep `loadExperienceHints(ctx.root)` + `formatExperienceHintsSection(...)` exactly as today (always compute).
  - The `experience_hint_surfaced` event (still deduped per (storyId, hintRoundKey), still only when `hasExperienceHints`) gains a `hintMode` field (on/off). Fires on BOTH arms.
  - Introduce a render-gated value: the section string used in `_reviewPrompt` is `hintMode === 'on' ? experienceHintsSection : ''`. Use THAT gated value both in the `_reviewPrompt` presence check (`experienceHintsSection === ''` guard at ~646) and where the section is concatenated — so the OFF arm's prompt is byte-identical to the no-hints case.
  - Do NOT touch the issues/blocker computation; do NOT touch resolveReviewPromptHash (core/review-run.ts) — hints remain out of it.
- Keep the no-hints byte-identical behavior (when no hints exist, both arms behave as today).

## CHK-003 — Smoke + npm script + verifier
- New `packages/main/src/tasks/experience-layer-ab-shadow-gate-smoke.ts`:
  - `resolveHintMode` deterministic (same id => same arm across calls) + roughly balanced over many synthetic ids (e.g. ~40-60% split over 1000 ids) + empty-string tolerated.
  - Drive story_review (or its prompt assembly) on a temp story whose cache has hints: pick a storyId that maps to 'on' and one that maps to 'off' (or stub resolveHintMode boundary); assert the ON-arm `_reviewPrompt` CONTAINS the 'Project experience hints (advisory only):' section and the OFF-arm `_reviewPrompt` does NOT, while in BOTH cases the experience_hint_surfaced event is recorded with the correct hintMode.
  - Assert the issues/blocker output and any computed promptHash are unchanged between arms (arm only affects the advisory section).
  - Print `ab-shadow-gate smoke passed`.
- `packages/main/package.json`: add `"test:experience-layer-ab-shadow-gate": "node dist/tasks/experience-layer-ab-shadow-gate-smoke.js"`.
- Committed `.lattice/story/actives/B-06b3/evidence/verify-b-06b3.mjs`: build clean + this smoke + no-regression smokes (finding-signals/playbook/recall/revalidation/learning-scan/signature-capture/hint-injection) + full `npm test` green (incl. process-fact-contract) + static checks: hint-mode.ts pure (imports only node:); story-review.ts does NOT pass hints into resolveReviewPromptHash and does NOT alter the issues/blocker block (only the advisory section + event payload). Map every verificationIntent; print `TOTAL N | PASS N | FAIL 0`.
