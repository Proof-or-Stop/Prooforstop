# Orchestrate Legacy Evidence Index

Proofbound starts from a clean source tree. The historical Orchestrate Lattice
story records and evidence archives are intentionally not copied into this
repository's `main` branch.

## Policy

- New Proofbound development records new lifecycle evidence in this repository.
- Legacy Orchestrate evidence remains local-only in the original archive.
- Do not commit old `.lattice/story/**` or `.lattice/artifacts/**` into this
  repository's `main` branch.
- Paper drafts may cite curated claims from this index, but raw review logs,
  delivery checks, process events, authority receipts, and transcripts remain
  in the local archive.

## Migration Anchor

- Source archive project: Orchestrate
- Clean export source commit: `379bc689106fe13931b027ed9eb176509b45e4f8`
- Export policy: source code and curated public-safe documentation only
- Excluded evidence classes:
  - `.lattice/story/**`
  - `.lattice/artifacts/**`
  - local authority trust files
  - local env/key files
  - runtime traces, locks, temporary logs, and worktrees

## Paper Evidence Workflow

When a paper claim needs historical support:

1. Resolve the claim to the legacy story ID, artifact path, or decision doc in
   the local Orchestrate archive.
2. Record only the claim, source commit, story ID, and sanitized summary here.
3. Keep raw evidence local unless it has been reviewed and explicitly promoted
   as public-safe documentation.

## Claim Map

| Claim | Legacy source | Sanitized note | Public-safe status |
| --- | --- | --- | --- |
| TBD | TBD | TBD | Not reviewed |
