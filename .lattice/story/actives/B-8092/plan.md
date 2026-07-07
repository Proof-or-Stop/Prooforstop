# B-8092 Plan: Cell06 Local Docker Probe

## Scope Boundary

This story validates a bounded local Docker probe for Cell06 A2prime runner readiness. It does not run the full/formal Cell06 dataset, does not run Cell02 or Cell04, does not upgrade paper claims, and does not change product gates or playbook activation.

The implementation should stay under `experiments/multi-model-ablation/cell06-docker-probe/**`. Related decision documents are read-only context, not edit targets.

## CHK-001 — Build or verify the local Docker Codex runner image

Create a minimal local Docker runner scaffold that can report the Codex CLI version from inside the container. The image must not depend on the host workspace being mounted wholesale. The runner must preserve the distinction between a real account auth bundle and an unavailable second-account bundle: unavailable account-b becomes `pending_auth`, never a fake successful provider row.

Verification will check the generated summary for `dockerImage.status=pass`, `containerCodexCliVersion`, and a visible file inventory that excludes host home, `.codex`, `.lattice`, Cell03 full outputs, and `lattice-Paper` paths.

## CHK-002 — Generate sterile probe row inputs and shard manifests

Generate two bounded Cell06/A2prime probe rows and their input manifests. Each row must have a stable `inputManifestDigest`, explicit `shardId`, `runnerAccountId`, cell/arm labels, and allowlisted input files only. Hidden/reference files, Cell03 outputs, reviewer feedback, Proofbound dev-memory, and paper text must not be copied into row input directories.

Verification will check the row count, row ownership uniqueness, manifest digests, and contamination-token absence in sterile inputs.

## CHK-003 — Run the local Docker probe and capture receipts

Run the local Docker path for available auth when possible, and capture compact receipt rows. If a second auth bundle is unavailable, emit explicit `pending_auth` receipt rows for that shard rather than claiming provider execution. The probe may include simulated/blocked receipts only when the status makes the limitation explicit.

Verification will check receipt shape, Cell06/A2prime labels, account/shard ownership, codex/container metadata, and absence of reviewer fields or Cell03/Proofbound-memory references.

## CHK-004 — Validate contamination scan and merge checks

Implement deterministic validation that accepts the generated probe summary/rows and rejects negative controls. Negative controls must cover injected Cell03/reviewer/Proofbound-memory/host-path contamination, duplicate row/account ownership, missing manifest digests, and wrong cell/arm labels.

Verification will run `node experiments/multi-model-ablation/cell06-docker-probe/validate-probe.mjs --summary experiments/multi-model-ablation/cell06-docker-probe/probe-summary.json --rows experiments/multi-model-ablation/cell06-docker-probe/probe-rows.jsonl --json` and require PASS.

## Execution Order

1. Create runner files and validator.
2. Generate sterile manifests and negative controls.
3. Build or verify the Docker image.
4. Run the bounded local probe.
5. Run validator and record verification evidence for all 12 intent refs.
6. Advance through REVIEW, TEST, and DONE only after evidence is fresh.

## Risk Controls

- Do not mount `/Users/jek`, the host home directory, the full repo, `.lattice`, `~/.codex`, `lattice-Paper`, or Cell03 result directories into the container.
- Use temporary auth mounts only for live container smoke, and do not persist auth material in the repository.
- Treat account-b as `pending_auth` until a separate auth bundle is provided.
- Keep probe rows intentionally small; full Cell06 execution requires a later story.
