# B-5773 Execution Plan

Docs-only standardization of the cli-engine English translation plan
(`docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md`).
No source code is modified; `cli-engine.ts` is read-only for verification.

## Execution order & dependencies

1. **CHK-001 — Glossary + CLI style guide (foundation).**
   Add two sections near the top of the doc: an English Glossary (term choices)
   and a CLI Style Guide (formatting rules). Everything else applies these rules,
   so this must land first. Also extend the `reviewStatus` enum doc with a
   `behavior-sensitive` marker used by CHK-004.

2. **CHK-004 — Enumerate & isolate behavior-sensitive rows (do early, before sweeping).**
   Scan the manifest for rows whose source is runtime code that matches Chinese
   (regex / `.test` / `.match` / Chinese-token parsing), starting from M668/M669.
   Mark them and add a dedicated "Behavior-sensitive rows" subsection requiring
   test updates. Done before CHK-002 so the glossary sweep never silently rewrites
   a behavior row as prose.

3. **CHK-002 — Glossary/style sweep across the 762-row manifest + T-table.**
   Apply the locked glossary via count-verified replacement script (per-term,
   exact expected counts), keeping T/M twins consistent. Re-check the
   762<->762 invariant and zero-Chinese-in-proposedEnglish after every pass.

4. **CHK-003 — Shorten over-long command descriptions.**
   Trim the long `command-description` rows (e.g. M215/M339/M543/M650/M655) to
   short imperative phrases per the style guide; rules move to schema/longHelp
   wording (described in the doc, not in code).

5. **CHK-005 — Wrapped-source merge rule.**
   Add a documented rule that wrapped multi-line source is one translation unit;
   apply to M004/M005 and any similar fragmented pairs.

## Verification
- After each pass: `grep` re-check 762 rows, 0 Chinese in `proposedEnglish`,
  `cli-engine.ts` not in the diff.
- TEST: `node bin/koala.js validate --story=B-5773` → ALL PASS, coverage intact.

## Out of scope (per scope boundary)
- Modifying `packages/main/src/cli-engine.ts` or any source.
- Renaming the code identifier `realMachineTests` ("real-machine tests" kept).
- Performing the actual source translation (a later implementation story).
