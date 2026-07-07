# Cell06 Docker Probe

This directory holds the bounded B-8092 probe for a sterile local Docker runner for Cell06 / `⑥` / `A2prime`.

## Scope

- The probe builds a minimal Node-based Docker image and asks it to report Codex CLI availability and version.
- The probe emits only three receipts: `probe-manifest.json`, `probe-rows.jsonl`, and `probe-summary.json`.
- The probe never writes auth material into the repository.
- The probe does not run the full Cell06 matrix. Full Cell06 execution is out of scope here.

## Auth Bundles

If you want the probe to attempt a real `codex exec` inside Docker, point these environment variables at external auth bundle directories:

```bash
export CELL06_ACCOUNT_A_AUTH_BUNDLE=/absolute/path/to/account-a-auth
export CELL06_ACCOUNT_B_AUTH_BUNDLE=/absolute/path/to/account-b-auth
```

Without a bundle, the probe records `pending_auth` for that account instead of pretending success.

## Run

```bash
node experiments/multi-model-ablation/cell06-docker-probe/run-probe.mjs --mode=local --rows=2 --json
```

## Validate

```bash
node experiments/multi-model-ablation/cell06-docker-probe/validate-probe.mjs --json
```

The validator checks the generated receipts and then replays the negative-control fixtures under `negative-controls/`.
