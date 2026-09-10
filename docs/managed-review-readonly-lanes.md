# Managed review readonly lanes

The registered `prooforstop-main-v1` adapter is opt-in through
`managedReviewIsolation: { mode: "readonly-build", adapter: "prooforstop-main-v1" }`.
It currently supports Darwin with the local `sandbox-exec` capability and the
registered Proof-or-Stop project layout. Unsupported requested configurations
fail before provider startup; projects without this opt-in keep their existing behavior.

Tracked review source and original project/Git files remain read-only to the
provider. Each lane builds its own four-package runtime and graph assets. Only
the declared lane output, temporary files, and cache are writable. The consumer
checks sealed source, generated links, and output bindings before accepting a
successful managed result. This does not make writable output immutable during
execution.

Codex uses a private `CODEX_HOME` copied from supported file-backed state.
Claude uses a private `CLAUDE_CONFIG_DIR` with supported file-backed credentials
or explicit noninteractive authentication environment variables. Original
credential files remain read-only; private credential copies are writable so a
provider can refresh its own lane state. Refreshes are not copied back.
Keyring-only or otherwise unsupported authentication state is rejected during
preflight, before the lane build. The adapter does not grant write access to HOME.

Acceptance uses an actual local Node provider witness through the managed
worker and verifies the signed invocation descriptor. It does not establish
that a real external Codex or Claude login or authenticated service request
succeeds. Real provider login compatibility remains a separate check.

The lane supplies a private `node_modules/.bin/tsc` bound to the installed
TypeScript package's declared `bin.tsc`; compiler package file identities are
sealed and rechecked. The bounded npm compatibility witness runs the graph
package's actual `typecheck` script with no global compiler on PATH and a failing
ambient compiler sentinel. This is not a claim that every repository npm script
can run inside a readonly lane. In particular, the ordinary main build promotes
`packages/main/dist.staging` and `dist.trash-*` beside the source dist link; those
source-parent writes remain denied. The trusted lane builder emits and promotes
inside the declared private runtime instead. Do not use the ordinary main build
to rebuild reviewed source in this adapter.

Credential/configuration preflight bounds each file to 1 MiB and uses JSON or
`smol-toml` parsing before compilation. Codex file state must contain a nonempty
`OPENAI_API_KEY`, or a `tokens` object with nonempty `access_token`,
`refresh_token`, and `id_token`. Claude file state must contain
`claudeAiOauth.accessToken` and `claudeAiOauth.refreshToken`; the registered
noninteractive environment route remains available. JSON settings must be an
object. An explicitly selected Codex credential store must be `file`.
These checks establish supported local syntax and shape only, not token validity
at a server. Errors do not echo credential/configuration contents.

Fresh `cross_host_review` runs use this adapter on their existing registered,
clean detached snapshot. The sealed spec retains `cross_host_review_codex` and
binds the snapshot HEAD and private build; it does not become an ordinary
managed-review scratch run. Both worker launch and successful result consumption
verify the binding. The cross-host controller and its existing garbage collector
retain snapshot cleanup ownership. Status reads remain valid after cleanup.

The trusted fresh-run controller resolves the original selected credential
directory before redacting the provider environment. Missing executables and
malformed supported credential files fail before snapshot creation or worker
startup. Providers receive the private credential copy, not write access to the
original directory. Resuming an existing run attaches its original sealed spec;
it does not build a new lane or retroactively certify legacy runs as isolated.

Capability readiness uses the shared synchronous provider supervisor, including
its machine/project admission and ordinary process-group cleanup. An actual
provider auth failure or timeout remains non-ready; unproven cleanup also cannot
produce READY. The readiness classifier retains its 256 KiB per-stream failure
threshold, while the supervisor bounds total captured output at its shared limit.
Readiness feeds the shared admission protocol described below.

## Shared readiness admission

For ordinary managed REVIEW lanes, the owner runs `reviewer_batch_admit` with
`storyId` and the complete `assignments` array. Each required lane appears once
as `{lane, kind: "native"}` or `{lane, kind: "managed", host: "codex" | "claude"}`.
The command requires the current signed OPEN inventory epoch and committed
material cutoff. It freezes that explicit roster under coordination locks;
callers cannot supply READY or their own execution identity. `reviewer_batch`
continues to be a read-only launch plan.

Concurrent callers with the same subject and inputs share one supervised probe
per managed host. Admission waits for every host. Unchanged failures remain
blocked; an owner can request a deliberate retry with `retryFromGeneration`.
Concurrent retries of the same generation reuse one successor. Interrupted
publication is recovered as blocked without an implicit probe.

The execution identity binds the complete effective base environment, captured
file credentials, resolved native executable bytes and permissions, physical
paths, launcher/profile and probe runtime through a private HMAC key. Undefined
environment values mean absent OS variables; defined values are all included.
Shebang interpreter chains are currently unsupported. The probe runs with a
private credential copy. Its refreshed state is persisted with keyed integrity
under the registered provider-seeds directory, bound to subject, generation and
host. Every lane materializes an independent writable cache from that seed.
Workers do not reread original credentials after admission.

New configured readonly managed submissions require admission before scratch
creation or compilation. Acceptance amendment and cross-host review controllers
use their own trusted singleton subjects before creating scratch or snapshots;
their internal authorization tokens cannot be reconstructed from caller JSON.
Existing idempotent runs attach their original sealed spec without new probes or
builds. Legacy specs are not retroactively certified as admitted.

The readiness lifetime bounds new lane consumption. A fresh consumption records
an immutable signed launch reservation for the exact run and deadline before
building. That reservation permits the same worker to start after the readiness
TTL if its own deadline has not passed. It does not permit new runs after expiry
or bypass current-generation checks. A deterministic provider auth failure
revokes its current generation with a signed immutable record. Queued workers
refuse it even if publishing the updated active record was interrupted. A late
failure from an older generation cannot revoke its successor. Final current-batch
verification and the per-run launch grant share the controller lock. The grant
is the launch ordering point; provider execution happens after releasing both
controller and run locks. Workers verify the sealed spec, full base
environment, refreshed private seed, current native executable/runtime and the
actual executable resolved through the lane PATH before granting launch.

The Darwin sandbox denies provider reads of the canonical admission subtree,
including keys, seeds, directory listings and symlink aliases. Original source
and Git remain readable; private lane cache refresh remains writable. Bounded
no-follow file reads reject malformed, nonregular and FIFO inputs. Read-only
admission inspection writes no state and performs no probes.

These checks establish local admission, isolation and launch behavior. Native
fixture readiness is not evidence of a real external login, review PASS, or
population-wide performance and reliability targets.
