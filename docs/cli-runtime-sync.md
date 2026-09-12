# CLI runtime after a repository update

Updating Git sources does not rebuild the installed CLI. A global symlink can
still point to the correct checkout while its `packages/main/dist` contains an
older release. This was observed with source 0.3.316 and a running CLI 0.3.314.

The CLI checks its compiled release version against its own package manifest
before dispatch, including help and version commands. A mismatch stops execution
with `CLI_RUNTIME_VERSION_MISMATCH` and identifies the actual installation.
The caller project's version is irrelevant. The check reads one small manifest
and does not scan Story history, acquire an owner lease, or rebuild automatically.

For a repository installation whose source constant matches the runtime manifest,
run `node scripts/ensure-dist.mjs` from the
identified checkout after installing its dependencies. That existing command
checks the source/build binding and prepares main and utils with build locking.
Then verify both `proof-or-stop --version` and `node bin/proof-or-stop.js --version`.
For a published installation, reinstall the intended package version instead.
An already-running process requires a new invocation to use updated code.
The refusal is before command dispatch, after the module import graph loads.
It also applies to a global-fallback session_brief heartbeat: a version-mismatched
installation must be repaired before that degraded path can be used. The wrapper
prints the version error directly instead of recommending the same stale entry.

This is a release mismatch guard. It does not prove that same-version edits have
been compiled or that every running owner/reviewer has migrated. Those require
the existing build binding and explicit execution implementation pins. An older
installed CLI must first receive this repair through the normal build/integration
path; a source-only update cannot retroactively patch a running binary.

The regression command is `node scripts/verify-cli-runtime-version.mjs`. It uses
an isolated installation, a different-version caller project, both CLI entry
shapes, and a package-only update. No real Story or main installation is changed.
It is also available as `npm run test:cli-runtime-version` and is included in the
runtime fact contract. The doctor package-version row compares manifests; it
does not independently measure this compiled-version startup invariant.

On mismatch the guard also inspects the installation's source version when it is
available. `SOURCE_VERSION_DESYNC` identifies a source/manifest disagreement;
reconcile the constant, root and runtime package manifests, and lockfiles through
the atomic version workflow before building. Rebuilding the same inconsistent
source is not a recovery. Without verifiable source, inspect the installation or
reinstall the intended package. Both versions remain visible in the refusal,
including when the requested command is `--version`; no stale write is allowed.

Adapter heartbeat diagnostics preserve leading runtime mismatch/invalid-metadata
refusals under `[heartbeat_runtime_version_mismatch]`, keeping the failing
installation path and recovery text. They remain hard failures; timeout, ordinary
nonzero exit and missing heartbeat activity are still separate failures.
