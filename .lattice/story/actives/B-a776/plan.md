# B-a776 Plan

## CHK-001

Extract `normalizeFlagKey` and `parseFlags` from `cli-engine.ts` into `packages/main/src/cli/flag-parser.ts`. Keep `cli-engine.ts` compatibility exports for `parseFlags` so existing tasks such as `cli-argument-ergonomics-smoke` keep importing from the historical surface. Preserve all parsing modes: JSON body stays in `runCli`, flag parsing continues to support `--key=value`, `--key value`, boolean flags, `key=value`, JSON array/object values, repeated array fields, number coercion, boolean coercion, and unknown-key passthrough for later schema validation.

## CHK-002

Extract help rendering/dry-run guidance and alias normalization into `packages/main/src/cli/help-renderer.ts` and `packages/main/src/cli/alias-normalizer.ts`. The help renderer receives `ToolDef[]`, brand data, command policies, and owner lease help callback rather than reading global state. The alias normalizer returns the canonical command and updated argv while preserving the existing `lattice ...` prefix behavior and consumed-argument rules. Do not move lifecycle special dispatch or gate ordering from `runCli`.

## CHK-003

Add `packages/main/src/tasks/cli-surface-smoke.ts` plus a package script if needed. The smoke should verify parser compatibility, help/dry-run text classes, nested alias dispatch, JSON body compatibility, and that command catalog/ownership/root extractions remain intact. Run build, process-fact contract, command-catalog smoke, cli-argument-ergonomics smoke, lattice-cli-migration smoke, and scope contract. Record verificationEvidence per intent only after commands pass.
