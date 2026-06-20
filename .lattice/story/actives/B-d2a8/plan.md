# Plan: Parallel-gate config resolution (B-d2a8, program Story 3)

Chosen: dedicated-two-param-helper. `resolveParallelGate(raw, profileDefault)` validates the
nested `parallelGate` object field-by-field with soft fallbacks; per-profile defaults per §4.7.

## CHK-001 — Populate AuditConfig.parallelGate in resolveAuditConfig (audit-config.ts)

Imports (single source): `VALID_PARALLEL_MODES`, `ParallelGateConfig`, `ParallelGateMode` from
`parallel-decomposition.js`.

Additions:
- `const PARALLEL_MODE_FALLBACK: ParallelGateMode = 'advise'`.
- `PARALLEL_GATE_PROFILE_DEFAULTS: Record<WorkflowProfile, ParallelGateConfig>` —
  light `{advise, 2, false}`, balanced `{advise, 3, false}`, strict `{block, 4, true}`.
- `resolveParallelGate(raw: unknown, profileDefault: ParallelGateConfig): ParallelGateConfig`:
  - `!raw || typeof raw !== 'object' || Array.isArray(raw)` -> return `{ ...profileDefault }`.
  - start from `{ ...profileDefault }` so MISSING sub-fields keep the profile default.
  - `mode`: if a string -> if `VALID_PARALLEL_MODES.has` use it; else `console.warn` + `PARALLEL_MODE_FALLBACK` (advise) — invalid mode degrades to the safe non-blocking value, NOT block.
  - `maxConcurrentReview`: if a finite number -> if `Number.isInteger && > 0` use it; else `console.warn` + keep profileDefault.
  - `broadGlobBlocks`: if a boolean -> use it; else keep profileDefault.
- In `resolveAuditConfig`: add `parallelGate: PARALLEL_GATE_PROFILE_DEFAULTS[profile] ?? PARALLEL_GATE_PROFILE_DEFAULTS.balanced` to the `profileDefaults` object (so the early no-user-config `return profileDefaults` carries a populated gate config); after the existing per-field merges set
  `merged.parallelGate = resolveParallelGate(userOverrides.parallelGate, profileDefaults.parallelGate)`.

## CHK-002 — Hermetic smoke packages/main/src/tasks/parallel-gate-config-smoke.ts

`resolveParallelGate` is unit-tested directly with a fixed `profileDefault`; `resolveAuditConfig`
is exercised against a temp `.lattice/audit-config.json` under `os.tmpdir()`. Assert:
- the 3 profile defaults (light advise/2/false, balanced advise/3/false, strict block/4/true) via `resolveAuditConfig` with NO user config.
- a valid override (mode block, max 5, broadGlobBlocks true) is applied.
- `mode: "off"` is accepted (the reversible escape hatch).
- an invalid mode (`"nope"`) warns and falls back to advise.
- a non-integer or `<= 0` maxConcurrentReview falls back to the profile default.
- a non-boolean broadGlobBlocks falls back to the profile default.
- a non-object parallelGate (string/array) yields all profile defaults with no crash.
- the no-user-config path still carries a populated parallelGate.
Register in `lattice.config.json` validate.commands.
