# B-9958 Real-Machine Transcript Diff

## Expected

The completed source-lineage / playbook-seed loop should expose historical learning as deduped, lineage-bound, non-authoritative playbook seed material. User-facing CLI output should show digest-bound dry-run proposal data without creating candidates, activating playbooks, or producing gate evidence.

## Actual Transcript

Captured with:

```sh
lattice live_smoke_transcript --storyId=B-9958 --capture='node packages/main/dist/cli.js playbook_seed_propose_batch --dryRun --limit=3 --json' --write --json
```

The captured command exited `0` and wrote:

- `evidence/live-smoke-transcript.json`
- `dryRun: true`
- `applied: false`
- `observeDigest: 5295b9e0b3ea79149bde7d153cd7fc7e59edcd7c34740b195875525225216025`
- `proposalManifestDigest: 36df665fd29332ed016d4bb597468f6a7f042b8889298f002533ce9e11074981`
- `proposalCount: 3`
- proposal rows include `canonicalSourceKey`, `canonicalSourceKeyVersion`, `canonicalizationPolicyHash`, source story/finding references, and candidate playbook digests.

Additional real-machine checks run from the built worktree CLI:

```sh
node packages/main/dist/cli.js playbook_seed_observe --json
```

Observed `authority: non_authoritative`, `gateEvidence: false`, `proposableSeeds: 596`, and the same observe digest.

```sh
node packages/main/dist/cli.js playbook_runtime_consumption_verify --json
```

Observed `authority: non_authoritative`, `gateEvidence: false`, `status: warn`, and diagnostic `no_active_playbooks_to_verify`, which is expected because this story does not activate playbooks.

```sh
node packages/main/dist/cli.js playbook_auto_promotion_apply --json
```

Observed default dry-run / non-authoritative posture. V2 auto-promotion remains disabled by design.

## Diff

No user-value mismatch for B-9958. The implemented CLI exposes deduped seed observation, digest-guarded dry-run proposal manifests, runtime consumption diagnostics, and disabled-by-default auto-promotion guard without treating learning artifacts as authoritative gate evidence.

The only expected limitation is intentional: B-9958 stops at V1 recommendations/runtime-consumption verification and V2 guardrails. It does not automatically activate advisory playbooks.
