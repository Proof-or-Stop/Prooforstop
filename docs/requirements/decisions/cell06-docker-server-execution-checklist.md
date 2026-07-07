# Cell 06 Docker Server Execution Checklist

Status: execution checklist for the next story. This document prepares the
server-side runbook for Cell 06 / protocol `⑥` / `A2prime`. It does not
authorize execution by itself.

## Purpose

Cell 06 is the E2 `A2prime` control arm. It must use the Cell 03-derived usage
lock for budget and sequencing only. It must not receive Proofbound memory,
playbooks, Cell 03 solutions, reviewer feedback, B-991d summaries, paper text,
or any other semantic guidance.

The preferred environment is:

```text
clean server
  Docker image with Codex CLI
    account A container -> deterministic shard A
    account B container -> deterministic shard B
```

The server and Docker layout are capacity infrastructure only. They are not
experimental factors.

## Local Docker vs Clean Server

Docker is the required isolation boundary. A clean server is operationally
useful, but it is not scientifically required if the local Docker run uses the
same sterile mount and auth rules.

Local Docker is acceptable when:

- The runner mounts only allowlisted Cell 06 input/output directories.
- The runner does not mount `/Users/jek`, `~/.codex`, Proofbound, `.lattice`,
  the paper repo, or Cell 03 full outputs.
- Each account uses a separate container `CODEX_HOME`.
- The prompt and input manifests pass contamination scan before execution.
- The merge validator records `runnerHost=local-docker` and verifies there is
  no row duplication, no model drift, no prompt/tool drift, and no memory leak.

A clean server is preferable when:

- Local machine contention, sleep, network changes, or long-running sessions
  make a multi-day run fragile.
- More accounts or shards need to run in parallel.
- The operator wants stronger evidence that no local Proofbound/paper files
  were available on the host at all.
- The run should continue while the local machine is offline.

Conclusion: use local Docker for speed and convenience if the mount allowlist
and contamination scanner are enforced. Use a clean server when operational
stability or stronger host-level isolation matters. Either way, the formal
evidence is the same only if the row manifests, receipts, and merge validator
prove the same sterile inputs.

## Non-Negotiable Experimental Boundary

- The controller may use Proofbound state, Cell 03 usage lock, manifests, and
  validators.
- The Cell 06 runner must see only allowlisted row inputs.
- `reviewerFamily` is structurally `not_applicable`.
- No reviewer, no playbook, no dev-memory, no `session_brief`, no Cell 03
  row outputs, no Cell 03 solutions, no reviewer feedback.
- Account switching is allowed only as runner capacity and must be recorded in
  receipts.
- A completed or failed row must not be rerun by another account to select a
  better result unless the frozen retry policy explicitly permits it and all
  attempts remain auditable.

## Server Preparation Checklist

Use a clean machine that does not contain the Proofbound repo, the paper repo,
`.lattice`, old Codex sessions, or Cell 03 full outputs.

Recommended baseline:

- Linux server, Ubuntu 22.04+ or Debian 12+.
- Docker Engine and Docker Compose plugin installed.
- Outbound HTTPS enabled for Codex/OpenAI access.
- At least 100 GB free disk for row packages, logs, and output JSONL.
- A dedicated Unix user, for example `cell06`.
- No global `~/.codex` from unrelated work.
- No host-level `.lattice`, playbook, dev-memory, paper, or Proofbound docs.

Create the server directory:

```bash
sudo mkdir -p /opt/proofbound-cell06
sudo chown -R "$USER":"$USER" /opt/proofbound-cell06
cd /opt/proofbound-cell06

mkdir -p docker scripts manifests inputs outputs secrets logs tmp
mkdir -p secrets/account-a secrets/account-b
chmod 700 secrets secrets/account-a secrets/account-b
```

Forbidden server uploads:

```text
Proofbound repo
Proofbound .lattice
Proofbound docs
Proofbound playbooks
Proofbound dev-memory
lattice-Paper repo
Cell 03 full workspaces
Cell 03 solutions
Cell 03 reviewer feedback
B-991d story summaries
hidden oracle files
```

Allowed uploads:

```text
Dockerfile
runner scripts
Cell 06 shard manifests
Cell 06 sterile row input packages
Cell 03-derived budget/usage numbers only
validator scripts
account-specific Codex auth secret or access token
```

## Docker Image

Create `/opt/proofbound-cell06/docker/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates coreutils findutils git jq python3 tini \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex

WORKDIR /work
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]
```

Build:

```bash
docker build -t proofbound-cell06-codex:latest /opt/proofbound-cell06/docker
docker run --rm proofbound-cell06-codex:latest codex --version
```

Record the image digest:

```bash
docker image inspect proofbound-cell06-codex:latest \
  --format '{{json .RepoDigests}} {{.Id}}' \
  | tee manifests/docker-image-digest.txt
```

## Codex Account Authentication

Two subscription accounts may run in parallel. Treat each as a separate runner
identity, not as an experimental factor.

Preferred setup: create separate Codex auth homes on the server by logging in
each account separately.

Account A:

```bash
docker run --rm -it \
  -e CODEX_HOME=/codex-auth \
  -v /opt/proofbound-cell06/secrets/account-a:/codex-auth \
  proofbound-cell06-codex:latest \
  codex login --device-auth
```

Account B:

```bash
docker run --rm -it \
  -e CODEX_HOME=/codex-auth \
  -v /opt/proofbound-cell06/secrets/account-b:/codex-auth \
  proofbound-cell06-codex:latest \
  codex login --device-auth
```

Verify both accounts without row inputs:

```bash
docker run --rm \
  -e CODEX_HOME=/codex-auth \
  -v /opt/proofbound-cell06/secrets/account-a:/codex-auth:ro \
  proofbound-cell06-codex:latest \
  codex exec --ephemeral --skip-git-repo-check --ignore-user-config \
    --ignore-rules --sandbox read-only --ask-for-approval never \
    "Return only: account-a codex smoke ok"

docker run --rm \
  -e CODEX_HOME=/codex-auth \
  -v /opt/proofbound-cell06/secrets/account-b:/codex-auth:ro \
  proofbound-cell06-codex:latest \
  codex exec --ephemeral --skip-git-repo-check --ignore-user-config \
    --ignore-rules --sandbox read-only --ask-for-approval never \
    "Return only: account-b codex smoke ok"
```

If using access tokens instead of persisted auth, inject the token only for the
single `codex exec` invocation. Do not export it job-wide.

## Shard Manifest

The Proofbound controller should produce a frozen shard manifest before any
provider execution. Deterministic split:

```text
shardIndex = sha256(cellKey) % shardCount
```

For two accounts:

```text
shard-0 -> account-a
shard-1 -> account-b
```

Required manifest fields:

```json
{
  "artifact": "cell06-shard-manifest",
  "cell": "⑥",
  "arm": "A2prime",
  "executorFamily": "E2",
  "reviewerFamily": "not_applicable",
  "shardCount": 2,
  "hashFunction": "sha256(cellKey) % shardCount",
  "promptDigest": "sha256:...",
  "toolSurfaceDigest": "sha256:...",
  "usageLockDigest": "sha256:...",
  "rows": [
    {
      "cellKey": "⑥|A2prime|...|E2|not_applicable",
      "shardId": "shard-0",
      "runnerAccountId": "codex-account-a",
      "inputManifestDigest": "sha256:..."
    }
  ]
}
```

## Sterile Row Input Package

Each row or shard input directory must contain only:

```text
input/
  task.json
  prompt.md
  acceptance.mjs
  budget.json
  tool-policy.json
  input-manifest.json
```

`input-manifest.json` must enumerate every file and digest. No unlisted file is
allowed to be visible to the runner.

Forbidden row input content:

```text
B-991d
Cell 03 semantic outcomes
Cell 03 solutions
Cell 03 reviewer feedback
Cell 03 full row records
session_brief
dev-memory
playbook
finding-signals
.lattice
Proofbound docs
paper text
hidden oracle
```

Cell 03-derived budget numbers are allowed only as budget/time/token limits,
not as examples or guidance.

## Runner Command Template

Use one container per shard. Mount only the account auth, shard input, and shard
output. Do not mount host home, Proofbound, `.lattice`, or paper directories.

Account A / shard 0:

```bash
docker run --rm \
  --name cell06-account-a-shard-0 \
  --network bridge \
  -e CODEX_HOME=/codex-auth \
  -v /opt/proofbound-cell06/secrets/account-a:/codex-auth:ro \
  -v /opt/proofbound-cell06/inputs/shard-0:/work/input:ro \
  -v /opt/proofbound-cell06/outputs/shard-0:/work/output \
  proofbound-cell06-codex:latest \
  bash -lc '
    set -euo pipefail
    codex exec \
      --ephemeral \
      --ignore-user-config \
      --ignore-rules \
      --skip-git-repo-check \
      --sandbox workspace-write \
      --ask-for-approval never \
      --cd /work/input \
      --json \
      -c "shell_environment_policy.inherit=\"none\"" \
      -c "shell_environment_policy.set={PATH=\"/usr/local/bin:/usr/bin:/bin\",HOME=\"/tmp/codex-home\",TMPDIR=\"/tmp\"}" \
      -o /work/output/final-message.txt \
      "$(cat /work/input/prompt.md)" \
      > /work/output/codex-events.jsonl
  '
```

Account B / shard 1:

```bash
docker run --rm \
  --name cell06-account-b-shard-1 \
  --network bridge \
  -e CODEX_HOME=/codex-auth \
  -v /opt/proofbound-cell06/secrets/account-b:/codex-auth:ro \
  -v /opt/proofbound-cell06/inputs/shard-1:/work/input:ro \
  -v /opt/proofbound-cell06/outputs/shard-1:/work/output \
  proofbound-cell06-codex:latest \
  bash -lc '
    set -euo pipefail
    codex exec \
      --ephemeral \
      --ignore-user-config \
      --ignore-rules \
      --skip-git-repo-check \
      --sandbox workspace-write \
      --ask-for-approval never \
      --cd /work/input \
      --json \
      -c "shell_environment_policy.inherit=\"none\"" \
      -c "shell_environment_policy.set={PATH=\"/usr/local/bin:/usr/bin:/bin\",HOME=\"/tmp/codex-home\",TMPDIR=\"/tmp\"}" \
      -o /work/output/final-message.txt \
      "$(cat /work/input/prompt.md)" \
      > /work/output/codex-events.jsonl
  '
```

If the runner needs to write solution files, use a per-row writable work
directory generated from the input package, not a mounted Proofbound repo.

## Parallel Execution Checklist

- Freeze shard manifest before execution.
- Start account A and account B containers only after manifest freeze.
- Record container image digest.
- Record account id per shard and per row.
- Record Codex CLI version inside the container.
- Record prompt digest, tool-surface digest, input manifest digest, and usage
  lock digest per row.
- Keep full `codex-events.jsonl` per row or shard.
- Keep final message per row or shard.
- Keep generated solution and acceptance output per row.
- Preserve failed, quota-failed, timeout, void, and retried attempts.

## Quota Exhaustion And Account Switching

Allowed:

```text
account-a quota_failed before row starts
  -> mark unstarted rows as reassigned
  -> account-b may run them
  -> receipt records reassignedFrom=codex-account-a
```

Not allowed:

```text
account-a completed or failed a row
  -> account-b reruns the same row
  -> better output is selected
```

unless the retry policy was frozen before execution and all attempts are kept.

Receipt fields for reassignment:

```json
{
  "cellKey": "⑥|A2prime|...|E2|not_applicable",
  "runnerAccountId": "codex-account-b",
  "reassignedFrom": "codex-account-a",
  "reassignmentReason": "quota_failed_before_start",
  "previousAttemptStatus": "not_started"
}
```

## Contamination Scan

Scan prompt, input files, final messages, event JSONL, generated solution, and
logs.

Required blocklist terms:

```text
B-991d
Cell 03
cell03
A4
reviewer feedback
session_brief
dev-memory
playbook
finding-signals
.lattice
Proofbound memory
future-cell03-results/full
lattice-Paper
```

Rules:

- Match in prompt/input package: stop the batch; runner input is contaminated.
- Match in model output/transcript: mark the row `void_contamination` unless
  the match is from an allowed literal in the row task itself.
- Match in controller logs only: keep separate from row evidence; do not expose
  it to the runner.

## Merge Validator Checklist

After shard completion, the controller must verify:

- Every expected Cell 06 cell key appears once as final, terminal exhausted,
  failed, quota failed, timeout, or void.
- No duplicate final rows.
- No row owned by more than one account unless reassignment is auditable and the
  prior status was not started or policy-permitted retry.
- Every row has an input manifest digest.
- Every row has a prompt digest and tool-surface digest matching the frozen
  manifest.
- Every row has a runner account id.
- Every row has a Codex CLI version and container image digest.
- `reviewerFamily` is always `not_applicable`.
- No reviewer evidence is present.
- Contamination scan passes or voids affected rows.
- Cell 06 claims remain locked until formal analysis is complete.

## Server Handoff Package

Before asking the server operator to start, prepare this tarball:

```text
cell06-server-handoff/
  docker/Dockerfile
  scripts/
    run-shard.sh
    contamination-scan.sh
    merge-validate.sh
  manifests/
    docker-image-digest.txt
    shard-manifest.json
    prompt-digest.txt
    tool-surface-digest.txt
    usage-lock-digest.txt
  inputs/
    shard-0/
    shard-1/
  README.md
```

Do not include secrets in the tarball. Account auth is installed directly on
the server under `/opt/proofbound-cell06/secrets/account-*`.

## Execution Order

1. Prepare clean server.
2. Build Docker image and record image digest.
3. Login account A and account B into separate `CODEX_HOME` directories.
4. Run both account smoke checks.
5. Upload frozen Cell 06 shard inputs and manifests.
6. Run contamination scan over inputs before provider execution.
7. Run a 2-5 row probe across both accounts.
8. Validate probe: row schema, no contamination, no duplicate ownership,
   expected outputs present.
9. Freeze full-run go/no-go record.
10. Run shard 0 and shard 1 in parallel.
11. Reassign only unstarted quota-failed rows if needed.
12. Merge outputs.
13. Run full merge validator and contamination scan.
14. Copy final evidence bundle back to the Proofbound controller.
15. Open/complete the Cell 06 Lattice story with validation, review, delivery
    check, DONE, and paper evidence mirror.

## Done Criteria For Server Preparation

- Server contains no Proofbound repo, `.lattice`, paper repo, or Cell 03 full
  outputs.
- Docker image builds and records digest.
- Account A and B authenticate in separate auth homes.
- Codex CLI smoke passes for both accounts.
- Shard manifest is frozen.
- Input contamination scan passes before execution.
- Probe rows complete and validate.
- Full-run command can be started and stopped without losing receipt data.

The next actual implementation story should turn this checklist into concrete
Cell 06 input-packaging, Docker runner, contamination scanner, shard runner,
merge validator, and paper mirror artifacts.
