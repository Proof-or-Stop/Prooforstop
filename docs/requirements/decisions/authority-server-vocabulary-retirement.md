# Authority Server Vocabulary Retirement

Status: active source of truth.

This document is the migration contract for retiring server-backed Authority
Server vocabulary from active Proofbound surfaces. The active CLI is a local
assurance system. It can prove admissibility of local evidence, signed/offline
receipt bundles, and local review quorum. It does not advertise or require a
live server-backed authority path.

## Banned Active Vocabulary

The following terms are banned from active user-facing code, docs, prompts,
generated help, command catalog descriptions, and validate config unless they
appear in an explicit legacy quarantine or in this contract:

- `Authority Server`
- `authorityDone`
- `fullAuthorityDone`
- `productionDone`
- `LATTICE_AUTHORITY_*`
- active `authority_*` command surfaces, including hidden aliases that appear
  in normal help, catalog output, validate config, or phase allowlists

The ban includes no-overclaim prose that teaches the old names as the way to
understand current behavior. Active docs should say what local assurance a
command can establish instead of describing current behavior through retired
completion flags.

## Replacement Vocabulary

Active surfaces must use the following vocabulary:

- local assurance
- `admissibilityStatus`
- `assuranceLevel`
- `evidenceScope`
- local review quorum
- signed/offline receipt bundle

The normal active claim shape is: fresh scoped evidence can become admissible
for a named local consumer at a named assurance level. A signed/offline receipt
bundle can bind local artifacts. A local review quorum can raise review
assurance. None of those concepts depends on a live server-backed authority
service.

## Active-Surface Scan Scope

The retired-vocabulary guard scans these active surfaces:

- root README and guide docs used by operators
- active agent prompts and project prompt assets
- CLI command names, aliases, descriptions, and generated `lattice help`
  / `lattice <command> --help` output
- active phase allowlists, validate commands, and command catalog data
- source files that produce user-facing CLI text for local assurance, DONE
  readiness, proof admissibility, receipt bundles, delivery checks, dispatch,
  autopilot, handoff, host, observability, and quorum surfaces

Generated build output, experimental baselines, archived evidence, and legacy
decision documents are not active surfaces, but legacy documents still must be
marked as retired, legacy, superseded, or out-of-core near the top when they
retain old vocabulary.

## Legacy Whitelist And Quarantine Rules

Legacy vocabulary may remain only under these conditions:

- This contract and the retired-vocabulary guard may include positive controls
  for the banned terms.
- Historical decision docs may retain the old terms when they begin with an
  explicit retired/legacy/out-of-core note and are not referenced as active
  implementation guidance.
- Compatibility-only data readers may retain old JSON field names when the file
  is explicitly quarantined and the active runtime does not advertise those
  names in help, docs, or normal operator output.
- Local cryptographic primitives may keep old file names only when the module
  is used for signed/offline receipt bundles or local quorum digests, not for a
  server-backed client, runner, or receipt gate.
- Smoke tests may include the banned words only as scanner positive controls or
  inside an explicit legacy quarantine block.

Retained compatibility must be hidden from normal help/catalog/config. A
compatibility alias that appears in active help is not quarantined; it is an
active surface and must be removed.

## Required Guard Behavior

The guard must prove all of the following:

- the contract exists and is referenced by the guard;
- each banned vocabulary item is covered by a positive control;
- normal help/catalog/config does not expose active `authority_*` surfaces;
- README, guide docs, prompts, and active command descriptions use local
  assurance vocabulary;
- whitelisted legacy files are explicit and narrow.

For B-c004, the guard also scans the control-plane and proof-admissibility
execution plans for retired active-future backlog phrases. Those plans may
describe external adapter boundaries, but they must not ask future work to
rebuild server-backed authority runtime, conformance, or production receipt
parity.
