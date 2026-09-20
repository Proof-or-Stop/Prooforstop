# Planned provider budget admission

The synchronous planned-step executor checks remaining provider calls and wall
time before its real provider transport. It bounds the transport's attempt count
by the remaining call allowance and divides remaining wall time across those
attempts. A provider step reports its actual attempts, rather than consuming one
call regardless of retries. Pre-launch refusals consume zero provider attempts.
The same context also covers provider repairs within that planned execution.

When the executor returns `budget_exceeded`, owners must collect the recorded
result and resolve the budget explicitly; do not initiate fallback, another
review wave or another job to evade the limit. Evidence reviewers should inspect
the actual transport attempts and timeout in the execution records, not infer
bounded cost from a final blocked label alone.

This is a per-plan, synchronous allowance, not a cross-job reservation service.
It does not control Codex Desktop heartbeats, desktop context construction or
every external CLI. Token amounts not reported by a provider remain unknown.
The existing token/cost meter checks reported amounts; it is not a hard upper
bound on the next provider response. Process startup and cleanup overhead are
outside the provider attempt timeout. These limitations are not changed by this
repair and must not be reported as globally solved.

Regression: `node scripts/verify-benchmark-real-entry.mjs` loads actual source
and intercepts only the paid-provider transport. It exercises call exhaustion,
retry exhaustion, expired time, timeout propagation and valid work, plus the
existing host-run budget/usage path. The transported usage payload is a fixture,
not a paid-provider measurement or a formal Story verification receipt.
