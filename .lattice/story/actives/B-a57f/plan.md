# B-a57f Execution Plan

Execute `docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md`.
Translate `packages/main/src/cli-engine.ts` (4031 lines, 767 Chinese-bearing) to
English + open-source guardrails. The 3 behavior-sensitive rows
(M668/M669/M750) are OUT OF SCOPE (follow-up story).

## Phase order & dependencies

1. **CHK-001 — Phase 0: extract script + freeze manifest (PREREQUISITE).**
   Add `scripts/extract-cli-engine-english-manifest.mjs` that scans
   cli-engine.ts and emits the line-level manifest (translationId, sourceLine,
   surface, chineseSource, proposedEnglish, reviewStatus). Regenerate against the
   CURRENT source (767 lines): re-anchor `sourceLine`, add the 5 drifted rows,
   carry over the approved English from the plan doc. **Re-scan for runtime
   Chinese matchers** (regex / `.test` / `.match` / `.includes` over Chinese) —
   if any exists beyond M668/M669/M750, mark it `behavior-sensitive` and defer it
   (do NOT translate). No source string is edited in this phase. Gate: every
   Chinese line maps to an approved (or deferred) row.

2. **CHK-002 — Phase 1: translate the public CLI surface.**
   Replace Chinese with approved English for command `description`, Zod
   `.describe(...)`, `printHelp(...)` labels/examples, validation error text,
   unknown-command suggestions, and story/worktree next-step hints (use the
   `Next:` style). Skip M668/M669/M750. **Update every test that asserts old
   Chinese output** (enumerate via grep over the test suite first). Rebuild +
   run validate.

3. **CHK-003 — Phase 2: translate internal comments.**
   After public output is stable, translate remaining Chinese comments in
   cli-engine.ts. Preserve technical meaning; no logic changes.

4. **CHK-004 — Phase 3: no-new-Chinese gate.**
   Add `english-open-source-surface-smoke` that fails on new Chinese in active
   source/docs, with allowlists for: the plan/review doc, generated manifests,
   legacy/archive docs, and migration-compatibility tests. Wire into the
   test/verify surface.

5. **CHK-005 — Phase 4: translate active docs + archive historical Chinese.**
   Translate README.md, docs/guide.md, docs/guide-hooks.md, and active files
   under docs/requirements/decisions/. Move historical Chinese-only material to
   explicit legacy/archive locations. Allowlisted (not retranslated): the plan
   doc and generated manifests.

## Verification
- After Phase 1/2: rebuild `packages/main`; `node bin/koala.js validate`.
- Phase 3 gate run; confirm it fails on a planted Chinese char (then revert).
- Final: `grep -cP CJK cli-engine.ts` == only the 3 deferred rows;
  `node bin/lattice.js help` and `lattice <cmd> --help` render English.

## Out of scope
- M668/M669/M750 (behavior-sensitive matchers) — follow-up story.
- Any CLI logic/control-flow change; retranslating the plan doc / generated manifests.
