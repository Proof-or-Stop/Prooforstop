# Authority Runner Session and Evidence Envelope

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

> Status: execution subdocument for
> [Authority Receipt Gate End-to-End Plan](authority-session-receipt-gate-execution.md).
> Owner: Runner / host execution plane.

## Purpose

This document defines how a runner proves that a provider execution belongs to a
specific Authority URL, actor key, runner id, session id, job, run, story, and
repo snapshot.

Runner output becomes production-relevant only after the server accepts signed
evidence and a later server gate decision consumes that evidence.

The runner role is host-neutral. Claude CLI, Codex CLI, Mac Runner, Runner CLI,
and CI can all act as execution hosts when they satisfy the same actor,
runner/session, job, signature, and evidence-envelope contracts. No host gets a
special trust shortcut.

## Runner Identity Inputs

Required live inputs:

- `LATTICE_AUTHORITY_URL`;
- runner provider, `LATTICE_AUTHORITY_RUNNER_PROVIDER` when the host is not the
  default `codex`;
- runner id, usually `LATTICE_AUTHORITY_RUNNER_ID` and otherwise derived by the
  CLI for the current process/provider/project;
- actor id;
- actor private key path or key provider;
- registered public key in the Authority Server actor registry;
- trusted server public key, pinned key id, or trusted discovery policy;
- optional `LATTICE_AUTHORITY_SESSION_ID`.

Missing live inputs must fail closed for Authority runner operations. Ordinary
local workflow may continue, but it must not produce receipt-backed authority
claims.

## Session Id Generation and Reuse

When no runner id or session id is configured, the CLI may derive them only
inside the approved authority-runner path. Explicit env/trust/authority.md ids
win. Derived ids are stable for the current process, provider, project, server
URL, host, and repo root, and are intended for one live runner process rather
than durable cross-host identity.

Rules:

- session ids are opaque and non-guessable;
- session ids are scoped to Authority URL + actor id + runner id + repo root;
- one runner process/session has one stable session id;
- stale session ids cannot be reused for a different Authority URL, actor id,
  runner id, or repo root;
- generated ids are persisted only in approved runtime/session storage;
- session ids are never written into arbitrary story prose;
- setting `LATTICE_AUTHORITY_SESSION_ID` manually does not create authority by
  itself.

## Runner Provider Routing

`LATTICE_AUTHORITY_RUNNER_PROVIDER` selects the host provider advertised during
runner registration/heartbeat and sent in the job claim filter. The declaration
is host-neutral metadata: the CLI accepts any non-empty string, defaults a
missing value to `codex`, and preserves legacy alias compatibility by
normalizing `claude` / `CLAUDE_CODE` to `claude-code`.

The CLI does not decide whether a custom declaration such as `codex-cli` or
`antigravity` is authorized. Server policy may reject unsupported declarations
during registration, heartbeat, or signed claim; that server rejection is the
authorization boundary. `authority_status` and `authority_enforce_runner
--dryRun` surface the resolved declaration and provenance without treating the
declaration as proof of readiness or ownership.

A `no-job` claim means the Authority server had no job matching the runner's
project/story lease filters and resolved provider declaration. It is not
permission to claim an unrelated handoff broadly. If a runner gets `no-job`,
check the server-issued job provider and the runner's
`LATTICE_AUTHORITY_RUNNER_PROVIDER`; do not bypass the server-side job/story
selector.

## Heartbeat and Claim Binding

The runner must establish a live session before claiming work.

Minimum flow:

```text
load authority config
  -> discover / pin server public key
  -> register or verify actor key
  -> send runner heartbeat with runnerId + sessionId + provider capabilities
  -> claim job with runnerId + sessionId + provider
  -> receive signed JobSpec / run metadata
```

The server must reject:

- heartbeat runner id mismatch;
- claim runner id mismatch;
- claim session id mismatch;
- stale heartbeat;
- unsupported provider capability;
- job claim for a different project/story;
- job claim without a live lease.

## Evidence Envelope Requirements

Runner-backed evidence must bind:

- `projectId`;
- `storyId`;
- `jobId`;
- `runId`;
- `runnerId`;
- `sessionId`;
- `actorId`;
- `producerRunId` when verifying a producer run;
- `verifierRunId` for verifier evidence;
- provider/model/vendor;
- repo `headHash`;
- repo `materialHash`;
- dirty state policy or clean assertion;
- command digest;
- transcript hash;
- diff hash for mutating producer runs;
- verification target id/digest when present;
- verification context pack id/digest when present;
- nonce;
- timestamp;
- actor signature.

The runner may include raw transcript snippets or excerpts only when policy
allows. Hashes are the default durable binding.

## Producer / Verifier Independence

For L2+ evidence:

- `producerRunId` and `verifierRunId` must both be present where policy requires
  run bindings;
- producer and verifier runs must be different;
- verifier run must belong to the evidence signing actor;
- verifier cannot verify its own producer run;
- provider/model/vendor diversity must be checked from server-owned run
  metadata, not self-reported envelope strings.

Same-run or same-actor evidence can still be stored as lower-trust evidence, but
it must not satisfy L2+ policy.

## Provider Execution Capture

A runner execution should capture:

- command invoked;
- normalized command digest;
- start/end timestamps;
- exit code;
- provider stdout/stderr or normalized event stream hashes;
- transcript hash;
- changed file list;
- diff hash;
- artifact digests;
- approval requests/decisions if applicable;
- failure reason for failed runs.

Failed provider execution must produce a failed envelope/receipt path or a
server-rejected path. It must never become a production completion claim.

## Evidence Submission and Receipt Retrieval

Minimum flow:

```text
execute provider job
  -> compute command/transcript/diff hashes
  -> sign evidence envelope
  -> submit evidence to Authority Server
  -> receive accepted evidence record / evidence receipt
  -> later fetch or request gate_decision receipt
```

The runner does not decide lifecycle gates. It produces signed inputs. The
Authority Server decides evidence acceptance and gate verdicts.

## Runner Tests

Minimum acceptance tests:

- generated session id is stable for one runner session;
- configured session id is validated for shape and scope;
- runner cannot claim job with mismatched session id;
- runner cannot claim job with unsupported provider capability;
- runner cannot submit evidence for a different story;
- transcript hash changes when transcript changes;
- diff hash changes when material diff changes;
- same-run producer/verifier evidence is rejected or downgraded;
- stale heartbeat blocks job claim;
- failed provider execution cannot emit production pass.
