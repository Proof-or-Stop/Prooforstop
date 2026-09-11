# CLI runtime after a repository update

Updating Git sources does not rebuild the installed CLI. A global symlink can
still point to the correct checkout while its `packages/main/dist` contains an
older release. This was observed with source 0.3.316 and a running CLI 0.3.314.

The CLI checks its compiled release version against its own package manifest
before dispatch, including help and version commands. A mismatch stops execution
with `CLI_RUNTIME_VERSION_MISMATCH` and identifies the actual installation.
The caller project's version is irrelevant. The check reads one small manifest
and does not scan Story history, acquire an owner lease, or rebuild automatically.

For a repository installation, run `node scripts/ensure-dist.mjs` from the
identified checkout after installing its dependencies. That existing command
checks the source/build binding and prepares main and utils with build locking.
Then verify both `proof-or-stop --version` and `node bin/proof-or-stop.js --version`.
For a published installation, reinstall the intended package version instead.
An already-running process requires a new invocation to use updated code.

This is a release mismatch guard. It does not prove that same-version edits have
been compiled or that every running owner/reviewer has migrated. Those require
the existing build binding and explicit execution implementation pins. An older
installed CLI must first receive this repair through the normal build/integration
path; a source-only update cannot retroactively patch a running binary.

The regression command is `node scripts/verify-cli-runtime-version.mjs`. It uses
an isolated installation, a different-version caller project, both CLI entry
shapes, and a package-only update. No real Story or main installation is changed.
