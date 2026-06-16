# Plan: B-5f42 Enforce English-only artifacts (warn-only hook + diff/story-scoped validate gate)

> Channel: normal (3 items, high-risk via the "validate" keyword). Owner: lattice-implementer per item.
> Decision B: layer 1 warn-only PreToolUse(Bash) hook + layer 2 hard CJK gate in the validate
> REVIEW->TEST preflight. Single CJK source of truth in core; the hook keeps a self-contained
> copy kept in sync by a test. Detection is diff/story-scoped; never flag legacy files.
> CRITICAL: .claude/settings.json and .claude/hooks/*.cjs are framework-generated managed assets.
> Edit the generation source (init-assets.ts + managed-assets.ts), then regenerate; do NOT hand-write artifacts.
> ALL artifacts, comments, and commits in this story must be English (dogfood).

## CHK-001: Warn-only PreToolUse(Bash) hook for CJK in commit / lattice story-metadata commands

**Owner**: lattice-implementer
**DependsOn**: CHK-002 (reuse the CJK range constant defined alongside core/cjk-detect.ts; if CHK-002 not yet landed, define the range in cjk-detect.ts first)
**Files**:
- Modify: packages/main/src/init-assets.ts (embed the new hook .cjs content; add a PreToolUse matcher "Bash" entry to getClaudeHooks())
- Modify: packages/main/src/core/managed-assets.ts (mergeClaudeHooks: include the new hook so check --apply keeps settings in sync)
- Modify: .claude/settings.json (regenerated output — produce via lattice check --apply or init, do not hand-edit)
- Create: .claude/hooks/english-only-guard.cjs (regenerated output from init-assets source)
- Test: packages/main/src/tasks/english-only-guards-smoke.ts

**How**:
- Model the hook after .claude/hooks/lattice-scope-pretool.cjs: read stdin JSON, parse tool_input.command; graceful pass-through (exit 0) on any error/malformed input.
- Match only when command looks like `git commit` or `lattice <story-metadata-cmd>` (story_create/checklist_add/checklist_update/decision_set/understanding_set/summary_set). On CJK match: write an English warning to stderr and exit 0 (warn-only, never block).
- Self-contained CJK regex (no dist import), per the pre-push external-defense principle. Keep its range identical to core/cjk-detect.ts (verified by the keep-in-sync test in CHK-003).
- Add the hook to getClaudeHooks() (init-assets.ts ~line 438) as a PreToolUse entry with matcher "Bash" via hookCommand('english-only-guard.cjs'); ensure mergeClaudeHooks treats it as managed.
- Regenerate .claude artifacts via lattice check --apply (or init) and commit them.

**Verify**:
- `printf '{"tool_input":{"command":"git commit -m \"<chinese>\""}}' | node .claude/hooks/english-only-guard.cjs` prints a warning, exit 0.
- English-only command -> no output, exit 0. Malformed stdin -> exit 0, no crash.
- `lattice check` reports .claude/settings.json in sync (no managed-asset drift).

**DoneWhen**:
- The hook is generated (not hand-written), warns on CJK in commit/lattice-metadata commands, never blocks, and managed-asset check is clean.

## CHK-002: Diff/story-scoped CJK gate in the validate REVIEW->TEST preflight

**Owner**: lattice-implementer
**DependsOn**: none (defines core/cjk-detect.ts)
**Files**:
- Create: packages/main/src/core/cjk-detect.ts (pure detector: detectCjk(text) -> matches with positions; exported CJK range constant = single source of truth)
- Create: packages/main/src/handlers/english-artifact-gate.ts (scan current-story commits + author-controlled metadata using cjk-detect)
- Modify: packages/main/src/handlers/review-preflight.ts (add an "english-artifacts" gate to runReviewCliGates so a CJK hit blocks REVIEW->TEST)
- Test: packages/main/src/tasks/english-only-guards-smoke.ts

**How**:
- core/cjk-detect.ts: pure function over a string, returns whether CJK is present and the matched line/column; export the CJK Unicode range list as the single source of truth.
- english-artifact-gate.ts: scope = git log main..HEAD commit subjects+bodies AND the current story author-controlled metadata files (background.md, index.json title/description/name, checklist.json item title/context/userSees, decision.json text, understanding.json text, plan.md, summary.json). Exclude framework/reviewer-generated and pure-runtime files (process-events.jsonl, process-metrics.json, owner-lease.json, review-runs.json, review-passes.json, findings.json). Never scan outside the current story dir or the branch diff.
- review-preflight.ts: register the gate in runReviewCliGates; on CJK found, gate.ok=false with an English message naming file/commit + line, so REVIEW->TEST blocks (consistent with the lint/channel gate shape).

**Verify**:
- A fixture commit message or story metadata with CJK -> gate fails non-zero, message names the artifact.
- English-only -> gate passes, validate green.
- A legacy Chinese file outside the current story is not flagged.

**DoneWhen**:
- The english-artifacts gate is part of the REVIEW->TEST preflight, diff/story-scoped, hard-fails on CJK, passes on English-only.

## CHK-003: Tests for the detector, the scope, the keep-in-sync, and the gate block

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Create: packages/main/src/tasks/english-only-guards-smoke.ts
- Test: packages/main/src/tasks/english-only-guards-smoke.ts

**How**:
- Detector unit cases: Chinese string detected; ASCII/English not detected; positions reported.
- Scope test: a fixture path outside the current story is not flagged by english-artifact-gate.
- Keep-in-sync test: the hook's self-contained CJK range equals core/cjk-detect.ts range.
- Gate-block integration: a CJK fixture flips english-artifact-gate to fail; English-only passes.
- Hook behavior: spawn english-only-guard.cjs with CJK input -> warning + exit 0; English input -> silent + exit 0.
- Wire the smoke into package.json scripts if other smokes are (follow the existing smoke convention).

**Verify**:
- `npm run <english-only-guards-smoke>` (or node dist path) prints all assertions green; a deliberate CJK fixture flips the gate to fail.

**DoneWhen**:
- All four test concerns are green and the deliberate CJK fixture proves the block is real, not silent.

## Acceptance (TEST->DONE)
- `lattice validate` all green; the new smoke green.
- verification coverage: all must-intents have evidence (recorded AFTER the source commit).
- Dogfood: this story's own commits + metadata are English, so the new gate passes on this very story.

## Out of scope (deferred)
- Retroactively translating or flagging legacy Chinese files.
- Scanning arbitrary code/doc files beyond commits + lattice story metadata.
- A blocking (deny) hook — layer 1 is warn-only by decision.
- Codex-host equivalent of the warn hook (Claude host only for now).
