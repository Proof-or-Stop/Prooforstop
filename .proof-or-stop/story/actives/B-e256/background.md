## Trigger Event

On 2026-09-02, `proof-or-stop session_brief` failed with permission denied after a rebuild emitted `packages/main/dist/cli.js` as mode 0644. Repro probe rp-mtk46lj8-90q9av and review rr-mtk4acx4-oqze5c bind that executable-bit failure to Story B-e256.

## Key Insights

TypeScript emits a fresh CLI entrypoint without executable bits, while `npm link` fixes permissions only at link time. Replacing `dist` therefore breaks the global symlink on a later real rebuild. Doctor also needs to distinguish the compiled runtime version from the package manifest and report an unverifiable compiled version as `unknown`.

## Solution Tradeoffs

Executable-bit validation and restoration run on the staging tree before the current `dist` is evicted. This preserves the working CLI if staging validation fails. Realpath containment rejects final symlinks and intermediate-directory symlink escapes before chmod, while missing bin targets remain benign for partial or first builds.

## Conversational Texture

The maintainer can rebuild normally and keep using the global `proof-or-stop` command. `proof-or-stop doctor` shows the resolved package, compiled version or `version=unknown`, file mode, executable status, and a precise read-only remediation when the global runtime drifts.
