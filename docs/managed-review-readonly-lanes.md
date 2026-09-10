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
This lifetime repair does not yet establish batch-wide shared readiness admission.

Provider file inputs can now be captured once as an opaque controller-local token.
Materialization copies those captured bytes into each private lane, so changing
the original auth file after capture cannot silently change that lane's input.
The token serializes no credential data and cannot be reconstructed from JSON.
Bounded no-follow reads reject malformed and symlink inputs. Existing direct
creation uses capture then materialization and retains per-lane writable caches.
Batch admission and post-probe credential refresh still require their dedicated
producer/consumer wiring; this API alone does not establish shared admission.

The shared batch-admission controller now stores signed operational generations
under the registered canonical runtime directory. Concurrent callers with the
same trusted subject/input identity share one probe per managed host. It waits
for all hosts before an admitted verdict, keeps unchanged failures sticky, and
turns an interrupted controller into a blocked generation. Read-only status
performs no writes or probes; cancellation while queued starts no probe.
This controller is not yet a managed-launch prerequisite: the complete roster,
execution-input producer and managed consumer wiring remain separate work.

The execution-input helper uses an opaque controller HMAC key to bind captured
file credentials, full effective environment, resolved native executable bytes
and permissions, physical paths, launcher/profile and probe runtime identity.
Its public result contains only a schema and keyed digest. Read-only key lookup
creates no files. Nonregular inputs and FIFO replacements fail without blocking;
shebang interpreter chains are currently unsupported and refused. The helper
does not infer equivalence between different private cache or working paths.
The Darwin reviewer sandbox denies reads of the canonical controller admission
subtree, derived from the original worktree. This includes directory listings and
symlink aliases, while source reads and private provider cache refresh remain
available. Actual managed admission consumption remains necessary before this
can authorize shared preflight reuse.

The read-only batch subject helper validates the current signed OPEN REVIEW epoch,
committed material cutoff, scope and candidate digests. Assignments must cover
every required lane exactly once with an explicit native or managed kind and a
managed host; a consumer can check its actual host and kind against that roster.
Missing or stale epochs are refused without rewriting inventory state. This
helper must be used within the producer/consumer coordination boundary; it does
not itself freeze future writes or install the managed launch gate.

Trusted producer code can now persist a captured refreshed file-cache seed with
controller-keyed integrity and exact subject, generation and host binding. A
read-only consumer loads an opaque snapshot and materializes independent lane
caches without opening the original credentials. Publication is exclusive;
missing, tampered, nonregular or mismatched seeds are refused. A crash during
hardlink publication may conservatively leave an unreadable seed rather than
allow partially published state. The future producer must use the registered
provider-seeds subtree, outside the controller generation-history directory.
This storage API does not create READY or verify a successful provider probe.
