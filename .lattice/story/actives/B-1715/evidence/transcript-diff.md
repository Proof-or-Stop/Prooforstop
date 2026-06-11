# B-1715 User-Value Transcript Diff

## Expected

Maintainer runs the current-worktree Koala runtime and can see hardcoded runtime facts in `doctor` output:

- `doctor --format=json` exposes a `runtime` section.
- Runtime keys include `cliEntrypoint`, `globalCoreRealpath`, `projectLocalBin`, `nodeVersion`, `packageVersion`, `validateSource`, and `externalReferencePolicy`.
- Text output includes `Runtime scan:`.
- Runtime scan does not claim external connectivity. External references are policy-only with `connectivityChecked=false`.
- Process gates remain separate from runtime facts.

## Actual

Command:

```bash
node packages/main/dist/cli.js doctor --format=json
```

Observed runtime JSON summary:

```json
{
  "runtimeSummary": {
    "status": "warn",
    "pass": 5,
    "warn": 2,
    "fail": 0
  },
  "runtimeKeys": [
    "cliEntrypoint",
    "globalCoreRealpath",
    "projectLocalBin",
    "nodeVersion",
    "packageVersion",
    "validateSource",
    "externalReferencePolicy"
  ],
  "validateSource": "warn",
  "externalReferencePolicy": {
    "status": "warn",
    "connectivityChecked": false,
    "policy": "reference-only"
  }
}
```

Command:

```bash
node packages/main/dist/cli.js doctor
```

Observed text transcript:

```text
Runtime scan:
  scope: self
  status: warn (5 pass, 2 warn, 0 fail)
  ✓ cli-entrypoint [hard] /Users/jek/Documents/Work/Orchestrate/packages/main/dist/cli.js
  ✓ global-core-realpath [hard] /Users/jek/Documents/Work/Orchestrate/packages/main
  ✓ project-local-bin [warn] absent
  ✓ node-version [warn] v22.13.0
  ✓ package-version [hard] 0.3.2
  ⚠ validate-source [warn] source=fallback
    - validate.ts/js/mts and configured validate.command(s) are missing; using advisory fallback discovery
    repair: Add validate.ts/js/mts or configure validate.command(s) in koala.config.json.
  ⚠ external-reference-policy [warn] 15 external refs, connectivityChecked=false
    - CLAUDE.md:555 story-review.ts:274 is reference-only; no health command semantics found
    - CLAUDE.md:658 scope-question-resolve.ts:28 is reference-only; no health command semantics found
    - CLAUDE.md:869 fn.ts:42 is reference-only; no health command semantics found
    - docs/requirements/decisions/cc-learnings.md:67 story-advance.ts:432 is reference-only; no health command semantics found
    - ... and 11 more
    repair: Document the owning health command or mark the reference as policy-only; localhost examples are treated as internal.
  note: runtime facts describe environment drift; process gates remain in process-fact-registry.
```

## Diff

No user-value gap found. The actual output exposes all required runtime facts, keeps runtime facts separate from process gates, and reports external references as policy-only warnings rather than connectivity proof.

The `warn` status is expected for this repository because validation currently relies on advisory fallback discovery and bounded docs/config references intentionally produce `reference-only` warnings until they have explicit health-command semantics.
