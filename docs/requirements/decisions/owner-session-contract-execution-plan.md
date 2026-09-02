# Owner Session Contract Execution Plan

Date: 2026-06-20
Story: B-a781
Status: execution plan; documentation only

## Purpose

This plan defines the target owner-session identity contract for Proof-or-Stop's local
story owner leases across Codex, Claude Code, Antigravity/agy, and future hosts.
It does not implement runtime code. Future implementation stories must use this
document as the execution plan before changing owner-lease, lifecycle, host
adapter, or scope-guard code.

Related truth sources:

- `docs/requirements/decisions/session-ownership-and-write-leases.md`
- `docs/requirements/decisions/story-lifecycle.md`
- `docs/guide-scope-guard.md`
- `docs/requirements/decisions/authority-runner-session-evidence-envelope.md`
- `docs/requirements/decisions/three-round-two-host-review-escalation-execution-plan.md`

## Problem

The story owner lease already solves the important local coordination problem:
one mutating owner session per story, stale takeover, and readable guidance in
`session_brief`. Its current session identity path, however, still contains
host-specific exceptions in core behavior:

- owner-lease resolution treats Claude Code's native session variable as a core
  input;
- some lifecycle event collection still reads ad hoc session variables instead
  of the shared owner-session resolver;
- ppid fallback remains useful for plain local terminals, but is too weak to be
  the normal path for hosts that spawn a fresh shell per tool call;
- Codex, Antigravity/agy, and future hosts need the same contract without adding
  one more host-specific branch to core each time.

The target is a host-neutral Proof-or-Stop contract: core code consumes one canonical
session id, while host adapters bridge each runtime's native signals into that
contract.

## Non-Goals

- Do not create a cryptographic identity system.
- Do not make local owner leases equivalent to Authority Server receipts.
- Do not use local session ids as reviewer attestation, production proof, or
  `authorityDone` / `fullAuthorityDone` evidence.
- Do not require every future host to expose a native stable session variable.
- Do not edit runtime code as part of B-a781.

## Canonical Contract

`PROOF_OR_STOP_SESSION_ID` is the only canonical owner-session id that core owner-lease
and lifecycle code should consume.

Contract:

- The value is an opaque, trimmed, non-empty string.
- It identifies one validated local task-and-agent/role boundary for accidental
  write-coordination only.
- It must remain stable across multiple `proof-or-stop` invocations made by the same
  task and agent/role, including across shell and parent-process changes.
- It must differ when either the task identity or the agent/role identity
  differs, even when both invocations share a repository, worktree, thread, or
  host provider.
- It is scoped to local coordination. A process can forge it by setting an env
  var, so it must never be treated as authentication.
- It may be displayed in `session_brief`, owner-lease errors, doctor output, and
  local process events.
- It must be an opaque derived canonical id in diagnostics. Raw host task,
  thread, run, agent, or role tokens must not be written to logs, arbitrary
  story prose, or used as a substitute for Authority runner session ids.

Diagnostic metadata may include a source such as `explicit-env`,
`host-adapter`, `generated-token`, or `derived-ppid`, plus a host provider string
such as `codex`, `claude-code`, `antigravity`, or `agy`. Gates must continue to
key ownership on the resolved session id, not on a self-reported provider label.

### Independent identity dimensions

The adapter boundary must validate two independent dimensions before deriving
the canonical id:

- `taskIdentity`: the durable host task/run/conversation boundary whose commands
  are expected to refresh one story owner lease;
- `agentOrRoleIdentity`: the durable agent or role operating within that task.

Repository root, worktree path, provider name, thread id, or any single shared
dimension is insufficient by itself. In particular, collapsing all agents in a
task onto a repo-, worktree-, or thread-only id would hide real concurrent
writers and is rejected.

Host adapters own extraction and validation of both dimensions. Generic core
code receives only the opaque canonical result and diagnostic source/provider;
it does not interpret raw host tokens. A future host must prove the same
two-dimensional boundary through the fake-host adapter contract before it can
participate without a core exception.

## Resolution Priority

The target resolver order is:

1. **Explicit canonical env**: a user, wrapper, runner, or host adapter sets
   `PROOF_OR_STOP_SESSION_ID`.
2. **Host adapter bridge**: a Proof-or-Stop-owned adapter maps a host-native stable
   task identity plus agent/role identity into `PROOF_OR_STOP_SESSION_ID` before core
   owner-lease code runs.
3. **Generated-token fallback**: when a host exposes a durable task boundary and
   a durable agent/role boundary but no canonical native id, the adapter creates
   and reuses a local opaque token for that validated pair.
4. **ppid degraded fallback**: when no canonical env, host adapter, or generated
   token is safely available, derive a degraded id from hostname,
   project/worktree root, and parent process id and emit a warning before
   mutating commands.

An explicit `PROOF_OR_STOP_SESSION_ID` is an assertion that the caller has already
derived the intended task-and-agent/role boundary; it remains first for
compatibility and operator control. When that assertion is absent, the adapter
must validate both dimensions rather than substituting a repo-, worktree-, or
thread-only surrogate.

The important migration is not the literal call stack. The important invariant is
that core owner-lease and lifecycle logic no longer contain host-specific env
exceptions such as "Claude Code gets a special branch." Host-specific knowledge
belongs at the adapter boundary.

## Local Boundary

The owner-session id is local, non-cryptographic coordination metadata.

It can prevent accidental concurrency mistakes:

- a second session mutating the same story is rejected;
- stale leases can be taken over explicitly;
- `session_brief` can tell an operator whether to proceed, wait, or run
  read-only commands.

It cannot prove identity:

- a local process can set another process's `PROOF_OR_STOP_SESSION_ID`;
- the id has no signing key, public key, server authority, or reviewer
  attestation;
- a generated token may be high entropy, but it is still only a local
  coordination token because local code can read or copy it;
- Authority runner session ids remain a separate live-runner contract bound to
  Authority URL, actor key, runner id, job, evidence envelope, and receipt
  verification.

Every implementation and review must preserve that boundary. A local owner
session id may explain who holds a lease; it may not upgrade local evidence into
Authority evidence.

## Host Adapter Bridge

The host adapter bridge is the only layer that may know provider-specific
session signals. It may be implemented as wrappers, launcher scripts, host
integration code, or a small adapter module, but the core owner-lease resolver
should only receive the canonical result.

Recommended adapter output:

```text
sessionId: canonical PROOF_OR_STOP_SESSION_ID value
sessionSource: explicit-env | host-adapter | generated-token | derived-ppid
hostProvider: codex | claude-code | antigravity | agy | <future-host>
taskIdentityValidated: boolean
agentOrRoleIdentityValidated: boolean
nativeSessionRef: optional opaque/redacted reference for debugging only
```

Adapters may consume raw host task and agent/role tokens only long enough to
validate the dimensions and derive the canonical id. Raw values must not cross
the adapter boundary or appear in lifecycle events, DEV-claim diagnostics,
owner-lease errors, or other logs.

### Claude Code

Claude Code currently has a native stable session signal that solved the
fresh-ppid problem. The target migration keeps that knowledge in the Claude Code
adapter:

- the adapter may read the Claude Code native stable session value;
- it must export or pass the corresponding `PROOF_OR_STOP_SESSION_ID`;
- core owner-lease code must not directly inspect Claude-specific env vars;
- diagnostics may still show `hostProvider=claude-code` and a source indicating
  that a host adapter supplied the id.

### Codex

Codex must use the same canonical contract:

- if the invoking environment already provides `PROOF_OR_STOP_SESSION_ID`, preserve it;
- use `CODEX_THREAD_ID` as the ordinary direct Codex task boundary when present
  (with legacy session candidates only as adapter fallbacks), pair it with the
  policy-distinct `main` role for a direct owner, and require spawned reviewer /
  intent / delivery wrappers to inject their true role;
- hash the raw thread/session and role dimensions at the adapter boundary; raw
  native values must never become activity or story process-event session ids;
- if no native stable signal is available, use the generated-token fallback for
  the Codex session;
- do not add Codex-specific env exceptions to core owner-lease code.

### Antigravity / agy

Antigravity/agy should follow the dispatch/pre-apply host identity already used
by scope-guard semantics:

- `antigravity` and `agy` remain provider strings for guard and diagnostics;
- the adapter bridges any stable native or launcher-provided signal into
  `PROOF_OR_STOP_SESSION_ID`;
- when no stable native signal exists, the adapter creates a generated token for
  the host session;
- core code must not branch on Antigravity/agy-specific env names.

### Future Hosts

A future host is onboarded by implementing the adapter contract, not by editing
core owner-lease rules.

Minimum onboarding checklist:

- name the provider string;
- declare and validate its durable task identity and durable agent/role identity;
- if both exist, derive and map an opaque `PROOF_OR_STOP_SESSION_ID` in the adapter;
- if both boundaries exist but no native canonical value exists, use
  generated-token fallback from approved runtime storage;
- if either boundary cannot be validated, use the warned degraded-ppid path;
- add host-specific tests at the adapter boundary;
- prove core owner-lease tests still pass without adding a new core exception.

## Generated-Token Fallback

Some hosts have a real session boundary but no stable native session env. For
those hosts, the adapter may generate a local token.

Rules:

- Generate an opaque token once for the validated task-and-agent/role pair, then
  reuse it for all `proof-or-stop` invocations made by that pair.
- Persist the token only in approved runtime/session storage or keep it in the
  adapter process if the adapter process is durable enough.
- Scope the lookup key and persisted value by project root, host provider,
  validated task identity, validated agent/role identity, and adapter boundary,
  so two roles or tasks in the same worktree never collide.
- Define storage ownership and cleanup at that same boundary. A token owned by
  one adapter task-and-role pair must not be reused or deleted by another pair.
- Persisted fallback records expire after seven days without a successful
  same-scope use. Every successful read renews `lastUsedAt` and `expiresAt`
  under the same scope lock without rotating the token. Resolution replaces a
  truly idle expired record under that lock; `doctor` reports
  healthy/expired/corrupt/orphan-lock/orphan-temp counts and `doctor --repair`
  removes only expired, corrupt, or abandoned store artifacts.
- Publish through a bounded per-scope lock and atomic temporary-file rename so
  concurrent creators converge on one token and a partial final file can be
  repaired without a permanent `EEXIST` wedge. Scope-specific cleanup computes
  the full project/provider/task/agent-or-role/boundary key and cannot delete a
  sibling task or role record.
- Register any persisted token path as a runtime artifact, ignored by git and
  excluded from material evidence.
- Do not write generated tokens or their raw lookup dimensions into story prose,
  requirements docs, review findings, or logs.
- Label generated-token sessions clearly in `session_brief` and doctor output.
- Treat generated tokens as local coordination tokens, not cryptographic
  identity, even if they are produced by a cryptographic random generator.

Generated-token fallback is preferable to ppid fallback when the host adapter
can define and preserve both durable identity dimensions. If the runtime cannot
validate either the task or agent/role boundary, generation is unsafe: use the
degraded ppid fallback and label it honestly.

## ppid Degraded Fallback

The ppid-derived id remains the last fallback for plain terminals, simple CI
jobs, or unmanaged environments.

Rules:

- Use it only after canonical env, host adapter bridge, and generated-token
  fallback all fail.
- Record `sessionSource=derived-ppid` or equivalent.
- `session_brief` and doctor output should label it as degraded.
- The guidance should prefer exporting `PROOF_OR_STOP_SESSION_ID` or using a supported
  host adapter when repeated commands self-reject as foreign owner sessions.
- Tests must preserve the known degradation: changing ppid changes the derived
  id, while changing project/worktree root or hostname also changes it.

This fallback is intentionally weaker. It is acceptable for local accidental
coordination because stale-lease takeover exists; it is not acceptable as a
review-independence or Authority-proof anchor.

## Migration Away From Core Host Exceptions

Future implementation should remove host-specific session exceptions from core
owner-lease and lifecycle paths in slices:

1. Introduce a host-neutral session identity module or adapter facade that
   returns the canonical id, source, and provider diagnostics.
2. Keep the existing behavior passing through the facade so the first code slice
   is behavior-preserving.
3. Move Claude Code native env handling out of owner-lease core and into the
   Claude Code adapter.
4. Route Codex and Antigravity/agy launch/dispatch paths through the adapter so
   they set or preserve `PROOF_OR_STOP_SESSION_ID`.
5. Replace lifecycle event collection and DEV-claim warnings that read ad hoc
   session env vars with the same shared canonical resolver consumed by owner
   leases.
6. Add generated-token fallback and runtime-artifact registration for any
   persisted token storage.
7. Update tests and docs so direct references to host-native env vars appear
   only in adapter code, adapter tests, and host-specific documentation.
8. After one compatibility window, fail the guardrail check if core owner-lease,
   lifecycle, or gate code reads host-native session env vars directly.

The compatibility window may preserve old behavior through the adapter, but it
must not leave two competing sources of truth in core.

## Verification Matrix

Future implementation must cover at least these cases:

| Case | Setup | Expected result |
| --- | --- | --- |
| Canonical env wins | `PROOF_OR_STOP_SESSION_ID=sess-a`; ppid changes | same session id; source is canonical or explicit env |
| Blank canonical env ignored | `PROOF_OR_STOP_SESSION_ID` is whitespace; adapter has stable id | adapter id is used |
| Claude Code bridge | Claude adapter sees its native stable session signal; ppid changes | same canonical id; no Claude-specific env read in core |
| Codex bridge | Codex wrapper passes canonical env or adapter-generated id | owner lease refresh recognizes the same session |
| Antigravity/agy bridge | dispatch/pre-apply flow starts provider `antigravity` or `agy` | provider is diagnostic; canonical id drives ownership |
| Future host onboarding | fake host adapter implements the contract | no core resolver change required |
| Task isolation | same provider/worktree/agent role; distinct validated task identities | canonical ids differ |
| Role isolation | same provider/worktree/task; distinct validated agent/role identities | canonical ids differ |
| Shared-boundary rejection | only repository, worktree, provider, or thread identity is available | generated-token path is rejected; warned degraded fallback is used |
| Generated token | host has no native canonical id but has durable task and agent/role boundaries | generated id is stable for that pair; storage is pair-scoped and ignored |
| ppid fallback | no env, no adapter, no generated token | derived id is produced with degraded source label |
| ppid degradation | same worktree but different ppid | derived ids differ and docs/doctor warn about degradation |
| Story owner gate | owner acquires lease, non-owner mutates | non-owner is rejected with owner id, cwd, heartbeat, stale flag, and next action |
| Lifecycle events | phase advance records session | event uses the same canonical resolver as owner leases |
| Local boundary | same env forged by another process | no Authority/review-proof claim is produced |
| Core exception guard | grep core owner-lease/lifecycle/gate code for host-native session env names | only adapter layer and adapter tests may match |
| Material hygiene | generated-token storage exists | path is registered as runtime artifact and does not dirty material diffs |

Suggested local verification commands for implementation stories:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:story-owner-lease-smoke
rg -n "CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_.*SESSION|AGY_.*SESSION|ANTIGRAVITY_.*SESSION" packages/main/src
git diff --check
```

The grep command is a guardrail, not a literal "zero matches everywhere" rule.
Matches are allowed in host adapter files, adapter tests, and docs that explain
the migration. Matches in owner-lease core, lifecycle gates, or generic command
orchestration should block the implementation review.

## Manual Transcript Evidence

Before runtime implementation begins, the implementation story must record
manual transcript evidence for parent-PID-changing invocations. The transcript
does not need to prove cryptographic identity; it proves local owner-lease
continuity under invocation shapes that previously caused false foreign-owner
sessions.

Minimum transcript set:

1. Run the same story-scoped mutating command through one invocation shape that
   changes parent PID while preserving the same `PROOF_OR_STOP_SESSION_ID`; the command
   must refresh or reuse the same owner lease.
2. Run the same command through a second, different parent-PID-changing shape
   that also preserves `PROOF_OR_STOP_SESSION_ID`; it must still resolve to the same
   owner session and not self-reject as a foreign owner.
3. Run a degraded comparison with no canonical env, no adapter signal, and no
   generated token; changing ppid must produce a distinct derived id or an
   explicit degraded-source warning.

Each transcript record should include story id, command, host provider, cwd,
git HEAD, material hash or document hash, observed session id/source, owner
lease before/after summary, and pass/fail result.

## Rollout Slices

### R0. Documentation, review, and transcript gate

Commit this canonical contract before any runtime code change. Bind two fresh,
independent real-host reviews to that document commit, then record the two
continuity transcripts and one degraded transcript from the Manual Transcript
Evidence section. Runtime implementation may begin only after all five
pre-implementation records pass.

### R1. Resolver facade

Create the host-neutral resolver facade and move current behavior behind it.
Keep all existing story owner lease smoke tests green.

### R2. Host adapter bridge

Add adapter entry points for Claude Code, Codex, Antigravity/agy, and a fake
future host fixture. Adapters map native or launcher-provided signals to
`PROOF_OR_STOP_SESSION_ID` before generic owner-lease code runs.

### R3. Generated-token fallback

Add approved runtime/session storage for adapter-generated local tokens, register
the storage path as a runtime artifact, and add cleanup/doctor visibility.

### R4. Core cleanup

Replace direct env reads in owner-lease core, lifecycle event collection, and
DEV-claim warnings with the shared resolver. Add a guardrail test or script that
keeps host-native session env names out of generic core paths.

### R5. Multi-host verification

After runtime implementation, run the verification matrix again on at least two
real hosts. One host must exercise a native or canonical env path, and the other
must exercise either another native path or generated-token fallback. Include
one degraded ppid-only run as a negative/degraded proof. Pre-implementation
document reviews and transcripts do not satisfy this post-implementation R5
requirement.

### R6. Compatibility removal

After the compatibility window, remove old host-specific exceptions from core
and update docs from "migration target" to "implemented behavior." Keep legacy
lease reading tolerant of older `sessionSource` values.

## Two-Host Review Evidence Before Implementation

Before any future story implements runtime code from this plan, it must first
commit this document, record two-host review evidence over that exact commit,
and record the two continuity plus one degraded transcript required above.

Minimum requirement:

- two independent host reviews, preferably Codex plus Claude Code; Codex plus
  Antigravity/agy is acceptable when Claude Code is unavailable;
- each review records `hostProvider`, reviewer/session id, command or transcript
  hash where available, story id, git HEAD, material hash or document hash, and
  timestamp;
- each review explicitly checks the local/non-cryptographic boundary, generated
  token scoping/ownership/cleanup, independent task and agent/role dimensions,
  ppid degradation, unchanged lease/takeover semantics, and migration away from
  core host-specific exceptions;
- both reviews must return PASS before implementation begins, or the
  implementation story must remain blocked until a human changes this plan;
- two reviews from the same host provider or the same local session do not count
  as the required two-host evidence;
- local two-host review evidence is still non-Authority evidence and must not
  claim `authorityDone`, `fullAuthorityDone`, or production completion.

The implementation reviewer should reject code work that cites this plan without
fresh two-host review evidence and all three transcripts bound to the document
commit it implements. Runtime implementation must preserve existing owner-lease,
stale-takeover, and local/non-Authority semantics.

## Acceptance Criteria

The target implementation is complete only when:

1. `PROOF_OR_STOP_SESSION_ID` is documented and implemented as the single canonical
   owner-session id consumed by generic core code.
2. Claude Code, Codex, Antigravity/agy, and a fake future host all reach the
   canonical contract through adapters that validate independent task and
   agent/role dimensions.
3. Hosts without native stable env can use generated-token fallback only when
   durable task and agent/role boundaries exist, with pair-scoped
   storage/ownership/cleanup and without dirtying material diffs.
4. ppid fallback remains available but visibly degraded.
5. Generic owner-lease/lifecycle code no longer contains host-specific session
   env exceptions, and lifecycle events plus DEV-claim diagnostics consume the
   shared resolver.
6. The verification matrix passes.
7. Implementation evidence includes the ordered document commit, fresh
   pre-implementation two-host reviews, two continuity transcripts, one degraded
   transcript, and the post-implementation real multi-host R5 verification.
8. Existing lease rejection, explicit stale takeover, and local
   non-authentication/non-Authority boundaries remain unchanged.
