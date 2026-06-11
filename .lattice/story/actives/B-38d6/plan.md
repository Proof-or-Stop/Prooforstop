# B-38d6 Plan - Remove Swift validation fallback from Lattice CLI gates

## Outcome Transcript

After this story, a maintainer can run validation in a repository that still has a legacy `Package.swift` and see that Lattice does not auto-run Swift anymore:

```text
$ koala validate --json
{"provider":"koala-verifier-no-validation-entry","status":"warn",...}
# no command entry with label "swift test"
```

Then the maintainer can add `lattice.config.json` with `validate.commands` and see the configured command run:

```text
$ koala validate --json
{"provider":"koala-verifier-configured-commands","status":"pass",...}
```

If only `koala.config.json` exists, validation still works, but config diagnostics identify it as a legacy fallback and point toward `lattice.config.json`.

## Execution Model

- Claude Code CLI performs implementation in this story worktree.
- Codex reviews diffs, runs Lattice gates, records evidence, and advances phases.
- Swift source/test files are not deleted in this story. The change is gate semantics and current-product guidance.
- `lattice.config.json` becomes canonical; `koala.config.json` remains a compatibility fallback.

## CHK-001 - Remove Swift from automatic validation fallback discovery

Implementation steps:

1. Update `packages/main/src/handlers/verifier.ts`:
   - Remove `Package.swift -> swift test` from `discoverFallbackValidationCommands`.
   - Keep explicit configured commands untouched, so a legacy repo can still run Swift through `validate.command(s)`.
   - Update no-entry details so fallback list no longer includes Swift as a standard automatic fallback.
2. Update `packages/main/src/core/runtime-environment-checks.ts`:
   - Remove `Package.swift -> swift test` from runtime fact fallback labels.
   - Ensure validation source warnings still explain fallback discovery is advisory.
3. Add/extend `packages/main/src/tasks/validation-protocol-smoke.ts` cases:
   - temp repo with only `Package.swift` returns no-validation-entry warn/skip and has no `swift test` command.
   - temp repo with explicit Swift `validate.commands` still runs that configured command.
4. Verify inline output does not advertise Swift automatic fallback.

Acceptance:

- `koala validate --json` no longer runs Swift just because `Package.swift` exists.
- Explicit configured Swift validation still works.
- CLI/runtime diagnostics no longer list Swift as automatic fallback.

## CHK-002 - Support lattice.config.json canonical config with koala.config.json fallback

Implementation steps:

1. Update `packages/main/src/core/config.ts`:
   - Resolve config in this order: `lattice.config.json`, then `koala.config.json`, then defaults.
   - Expose enough source metadata or helper API for diagnostics/tests to know which config file was used.
   - Do not silently merge conflicting configs; canonical `lattice.config.json` wins.
2. Update validation setup scanning where needed:
   - `configuredValidationCommands` should naturally consume canonical config through `loadConfig`.
   - Diagnostics should say when legacy `koala.config.json` was used and when `lattice.config.json` shadowed it.
3. Add validation protocol smoke cases:
   - `lattice.config.json` validate.commands are loaded and run.
   - legacy-only `koala.config.json` validate.commands still run.
   - both files present: `lattice.config.json` wins and diagnostics identify the selected canonical source.

Acceptance:

- Existing repos with only `koala.config.json` keep working.
- New repos can use `lattice.config.json`.
- Conflict behavior is observable and deterministic.

## CHK-003 - Update validation protocol tests and docs for Lattice-first validation

Implementation steps:

1. Update `docs/requirements/decisions/testing-infra.md`:
   - Current execution priority references `lattice.config.json` first.
   - `koala.config.json` is described as legacy compatibility fallback.
   - Swift automatic fallback is removed from current project-native discovery docs.
   - Swift remains mentioned only in explicit legacy executor / configured-command contexts if needed.
2. Update README / CLI prompt / doctor text if they describe `koala.config.json` as canonical or Swift as current fallback.
3. Keep historical docs/story evidence intact; do not rewrite old stories that truthfully captured Swift runs at the time.
4. Rebuild Orchestrate CLI dist so Koala bootstrap can consume the new behavior.

Acceptance:

- Current maintainer guidance points to `lattice.config.json`, `validate.js`, or configured commands.
- No current long-form validation guidance treats Swift/Mac Native as the default product gate.
- `npm run test:validation-protocol`, dispatch runtime smoke, and runtime fact contract pass.

## Verification Commands

Run from Orchestrate worktree unless noted:

```bash
npm install
npm --prefix packages/main run build
npm --prefix packages/main run test:validation-protocol
npm --prefix packages/main run test:runtime-fact-contract
npm --prefix packages/main run test:dispatch-run-smoke
npm --prefix packages/main run test:host-overflow-smoke
git diff --check
lattice validate --story=B-38d6 --json
```

Manual acceptance after implementation:

```bash
TMP=$(mktemp -d)
cd "$TMP"
git init -q
printf '// legacy swift marker\n' > Package.swift
lattice --root "$TMP" validate --json
# assert: no swift test command; provider is no-validation-entry warn/skip
```

## Risks

- Config source diagnostics may require changing `loadConfig` API; keep backward-compatible default export behavior.
- Some tests may assert old fallback labels; update tests only where the product contract changed.
- Dist rebuild is required after Orchestrate source changes, otherwise Koala may keep using stale CLI behavior.
