# Plan: shift the CJK / english-artifacts check left to story_create + background_set

## Overview
Workflow-friction fix #4. Reuse the canonical detectCjk predicate (core/cjk-detect.ts, already used by the REVIEW->TEST english-artifacts gate) at AUTHORING time so non-English author artifacts are refused at story_create / background_set instead of only at the gate. Reference impl in /tmp/s4-cjkcreate (re-author reusing core/cjk-detect.ts).

## CHK-001: Reject non-English (CJK) author artifacts at story_create and background_set
Import detectCjk from packages/main/src/core/cjk-detect.ts and call it (via a small refusal helper) in:
- story-create.ts (story_create): scan the author-provided background + each checklist item title/context/userSees + title/description; on CJK, REFUSE with a field-named message (non-English (CJK) text in <field> (<section>):<line> ... [english_artifact_cjk_authoring]) and do NOT create the story.
- background.ts (background_set + background_append): scan the provided content; refuse before writing if CJK present.
If a shared helper is cleaner, export it from english-artifact-gate.ts but it MUST wrap the same core/cjk-detect.ts detectCjk (no second regex). Limit the scan to author-controlled artifacts only; never code/runtime files. em-dash U+2014 must not be flagged.

Add packages/main/src/tasks/english-early-check-smoke.ts proving: (a) story_create with CJK in background is REFUSED + no story dir; (b) story_create with CJK in a checklist title/context is REFUSED + no dir; (c) all-English story_create (incl. em-dash) succeeds; (d) background_set with CJK is REFUSED before writing; (e) the early check uses the SAME predicate as runEnglishArtifactGate (assert agreement). Register the smoke in lattice.config.json validate.commands.

Files: modify story-create.ts, background.ts, english-artifact-gate.ts (only if exporting a shared wrapper), lattice.config.json; create english-early-check-smoke.ts.

Acceptance: npm --prefix packages/main run build exit 0; english-early-check-smoke.js passes; an English story_create still works; lifecycle-registry-contract.js 0 divergences; validate --story=B-9137 all-green.
