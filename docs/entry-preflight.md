# Entry preflight

Run `npm run preflight:entry -- --root /path/to/project --storyId B-xxxx --json`
from the intended runtime checkout. Omit `--storyId` for runtime-only diagnostics.
The equivalent direct entry is `node scripts/entry-preflight.mjs`.

The bootstrap uses only Node builtins, so missing installed packages or build
outputs do not hide configuration syntax, realpath, Git pointer and dependency
installation problems. Inherited parent dependencies and packages with only ESM
or subpath exports are accepted without executing their code.

Independent runtime and Story probes run concurrently with a 30-second timeout
per probe. They reuse the runtime registry, worktree resolver, planned-path
validator and the same touchpoint coverage helper as `story_review`. A failed
probe is `UNAVAILABLE`, not a pass. Each concrete declared path is checked
independently. Create/test paths may be new; missing modify paths and paths that
escape the project are reported. Glob existence is advisory. These checks cover
configuration syntax/path shape and planned path declarations, not every field
of every persisted artifact.

Malformed checklist items, path fields and understanding touchpoints remain
blocking, but do not suppress independently readable path and coverage checks.
Partial diagnostic projections never claim complete coverage PASS and never
replace the original input used by the planned-path schema validator. Legacy
items without a file mapping retain the existing advisory behavior. No projected
or corrected data is written back to the Story.

The report is diagnostic only. `diagnosticsReady` means no reported blocker or
unavailable probe; it grants no lifecycle, scope, decision, review or release
authority. For INIT, the existing `init_preflight` report supplies the actual
INIT_CHECK gate result separately. The existing command keeps its no-command,
no-write contract. The new entry never installs packages, builds, launches
reviewers, writes evidence, signs artifacts or advances a phase. Unknown flags,
including `--apply`, are rejected.

`elapsedMs` is the observed duration of this invocation. It is not evidence that
the original plan's population P95 target has been met.
