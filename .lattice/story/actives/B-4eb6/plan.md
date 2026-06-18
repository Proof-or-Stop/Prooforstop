# Plan — B-4eb6: Experience Layer ③.1 `learning_scan`

Activates the previously-inert advisory hints by writing the finding-signals cache the Phase 1.5 hint loader reads. Reuses the existing derive+persist machinery; the only write is the materialHash-excluded learning cache; no gate, no finding, no scoring/promptHash change.

## CHK-001 — `learning_scan` handler (derive + persist)

- New `packages/main/src/handlers/learning-scan.ts`, `createLearningScanHandlers(ctx)` returning `{ learning_scan(args) }`.
- `learning_scan(args: { json?: boolean; story?: string })`:
  - `const projectRoot = ctx.projectRoot ?? process.cwd();` (use whatever the handler context exposes; mirror sibling handlers).
  - `const now = new Date().toISOString();` (real time; handler, not a workflow script).
  - `const storyIds = args.story ? [args.story.trim()] : undefined;`
  - `const cache = deriveFindingSignalsFromStore(ctx.store, { projectRoot, now, ...(storyIds ? { storyIds } : {}) });` — passing `projectRoot` persists via `writeFindingSignals` to `.lattice/learning/finding-signals.json`.
  - Human render: `learning_scan: derived <n> signal(s) over <storyCount> story scan` + `wrote <path> (schemaVersion <v>, updatedAt <now>)` + an advisory/no-gate note. `--json` → `{ written: true, path, signals: <n>, updatedAt }`.
  - Reads findings only via store ports; the ONLY write is the advisory cache; no finding_add, no gate.

## CHK-002 — Register as a writing (non-read-only) L2 experience-layer command

- `registry.ts`: `registry.registerBatch(createLearningScanHandlers(ctx));` (near the other experience-layer handlers).
- `cli-engine.ts`: command entry `learning_scan` with schema `{ json?: boolean, story?: string }` and a description noting it writes the advisory learning cache. Do NOT add to `READ_ONLY_COMMANDS` (it writes).
- `core/config.ts` `DEFAULT_PHASE_TOOLS`: allow `learning_scan` where appropriate (group with the experience-layer commands; an out-of-band maintenance writer — match how `signature_registry_set` / `playbook_*` are gated).
- `core/command-policy.ts`: a NON-readOnly experience-layer entry (`status:'supported'`, a writing ownershipClass like the `signature_registry_set`/`playbook_propose` entries, suitable `allowedPhases`, `destructiveRisk:'none'`, reason noting it writes only the advisory `.lattice/learning/` cache and cannot satisfy DONE/authority evidence).
- `core/process-fact-levels.ts` `PROCESS_FACT_LEVELS`: add `{ name: 'learning_scan', level: 'L2', category: 'experience-layer', owner: 'handlers/learning-scan', rationale: 'Derives and persists the advisory finding-signals cache under .lattice/learning/ through the store read ports; no gate reads it.' }` (mirror `signature_registry_set`). REQUIRED or the process-fact-contract suite fails.

## CHK-003 — Smoke + npm script + verifier (incl. end-to-end scan→hint-fires)

- New `packages/main/src/tasks/experience-layer-learning-scan-smoke.ts`:
  - Against a temp store (or the real repo) run the scan and assert `.lattice/learning/finding-signals.json` is written with a valid `FindingSignalsCache` (schemaVersion, `signals[]`, `anchorFiles` present where applicable); re-running is deterministic given a pinned now.
  - **End-to-end (addresses the product-reviewer advisory):** assert the Phase 1.5 hint loader (`experience-hint-loader`) returns NO hints before the scan (empty/absent cache) and a NON-empty hints section after the scan for a story whose findings match accumulated signals — proving the loop activates, not merely that a file was written.
  - Print `learning-scan smoke passed`.
- `packages/main/package.json`: add `"test:experience-layer-learning-scan": "node dist/tasks/experience-layer-learning-scan-smoke.js"`.
- Committed `.lattice/story/actives/B-4eb6/evidence/verify-b-4eb6.mjs` (model on B-a2e3): build clean + this smoke + no-regression smokes (finding-signals/playbook/recall/revalidation) + full `npm test` green (esp. process-fact-contract) + static checks (command registered across cli-engine/registry/config/command-policy/process-fact-levels; NOT in READ_ONLY_COMMANDS; ownershipClass not readOnly). Maps every verificationIntent; prints `TOTAL N | PASS N | FAIL 0`.
