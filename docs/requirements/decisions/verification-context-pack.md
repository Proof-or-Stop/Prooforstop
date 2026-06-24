# Verification Context Pack

## Background

On 2026-05-20, the Python authority server introduced a stricter authority evidence gate: an L2 verifier may not submit a natural-language conclusion alone, but should submit structured evidence that is traceable, replayable, and coverable. The Proofbound CLI needs to synchronize with this protocol; otherwise a verifier may still miss key diffs, use weak test commands, or hand the server a conclusion that has no covering artifact.

This document is the long-term source of truth on the Orchestrate side, describing how the Proofbound CLI and the Python authority server coordinate on the Verification Context Pack.

## Design Decisions

The Proofbound CLI is responsible for mechanically generating the Verification Context Pack. The external Python authority server is responsible for issuing verifier jobs, validating the evidence envelope, and enforcing gate adequacy. The fields, digest rules, and default coverage semantics on both sides should stay consistent; however, the Python-side preset, limit, and gate details may be regarded as locally-landed facts in Orchestrate only when there is an explicit code/doc reference in this repo.

The Context Pack is the verifier's default reading boundary, not a natural-language suggestion. It should contain changed files, changed hunks, changed symbols, source snippets, checklist item ids, test intent refs, oracle refs, required commands, risk tags, limitations, token budget, the truncated marker, and the parent digest of an expansion pack.
When the diff contains deleted files, the default source snippets should still provide readable deletion context; if the source is no longer in the worktree, the CLI must derive the snippet content from the diff/removed lines rather than leaving it blank.

A verifier may request an expanded context, but the expansion must carry an `expansionReason`. If the external authority server has its own `maxContextPackExpansionDepth`, `maxContextPackEstimatedTokens`, or preset-level limits, those are authority-side expected/to-be-aligned constraints and should not be written as locally-landed facts in this repo's documentation. An expansion is not a way to bypass the context pack, but forms a parent-linked pack chain.

## CLI Responsibilities

- `verification_context_pack_create` mechanically generates a pack from the current git diff, and does not write story metadata.
- `verification_context_pack_expand` generates a controlled expansion based on a parent pack, and must state the reason for the expansion.
- `digestVerificationContextPack` maintains canonical digest parity with Python's `VerificationContextPack.digest()`.
- `buildTargetBoundEvidenceEnvelope` and `EvidenceCollector` by default include the context pack's required refs in `coveredRefs`, and populate `verificationContextPackId`, `verificationContextPackDigest`, and `inspectedPackRefs`.
- In the CLI command policy, these two commands should be read-only / all phases / non-destructive.

## Server Coordination

The external Python authority server's verifier job is expected to bind a signed context pack and digest. When L2 evidence is submitted, the authority side typically checks whether the pack id, digest, producerRunId, and diffHash in the evidence match the server-issued verifier job; this repo is only responsible for the CLI-side fields and digest output.

The external authority gate is expected to require that the pack's files, hunks, oracle refs, test intent refs, required commands, and so on are covered, otherwise the evidence is insufficient. The responsibility currently landed in this repo is to stably map these required refs onto evidence surfaces such as `coveredRefs` / `inspectedPackRefs` for the authority side to consume.

If the authority side in the future, or an external deployment, enables presets such as `anti-hallucination` or `strict-ci`, the verifier job is expected to be required to carry a context pack; as of this repo's current state, these preset names are external authority constraints, not established facts of this repo's local gate.

## Verification Commands

On the CLI side, at minimum run:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:verification-context-pack
npm --prefix packages/main run test:command-ownership-contract
```

On the external Python authority server side, to verify protocol alignment, run the corresponding regression:

```bash
uv run pytest -q
```

## Subsequent Maintenance Rules

When modifying the authority/evidence/context-pack-related code of the Proofbound CLI in the future, you must first establish or restore a Story per Orchestrate's Proofbound story flow, and run `lattice session_brief` and `lattice aux_doc_list`. Unless the user explicitly requests a quick patch, do not bypass Story/checklist/verificationEvidence.

Whenever you modify any of the following, you must synchronously check the protocol fields and tests of the external Python authority server:

- `packages/main/src/core/authority-contracts.ts`
- `packages/main/src/core/evidence-collector.ts`
- `packages/main/src/core/verification-context-pack.ts`
- `packages/main/src/handlers/verification-context-pack.ts`
- `packages/main/src/cli-engine.ts`
- `packages/main/src/core/command-policy.ts`

Key checks on the corresponding external Python side:

- `cord_team.schemas.verification.VerificationContextPack`
- `cord_team.schemas.command.EvidenceEnvelope`
- `cord_team.services.job_scheduler`
- `cord_team.services.authority_records`
- `cord_team.domain.evidence_adequacy`
- `cord_team.services.gate_service`
