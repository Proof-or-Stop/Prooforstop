# B-d674 Plan

Goal: make Antigravity CLI the current third Lattice host runtime via the `agy` command, while keeping `gemini` only as deprecated legacy compatibility where removing it would break existing records. This story does not perform the larger cli-engine modularization work.

## CHK-001

Register Antigravity as a first-class host runtime.

Implementation steps:
- Inspect host runtime id normalization, probe, list, dispatch fallback, and capability profile code.
- Add `antigravity` as a canonical host id with `agy` as its CLI command.
- Accept `agy` as an alias only when it maps to canonical `antigravity`; do not advertise `gemini` as current.
- Keep `gemini` accepted only as deprecated legacy compatibility if persisted records or existing policy paths require it.
- Keep unattended safety conservative unless the existing bounded provider path already proves the claim.

Verification:
- `node bin/lattice.js host_runtime_probe --host=antigravity --json` reports `host=antigravity` and `cliCommand=agy`.
- `node bin/lattice.js host_runtime_probe --host=agy --json` normalizes to Antigravity or otherwise provides an explicit supported alias result.
- Legacy `node bin/lattice.js host_runtime_probe --host=gemini --json` remains bounded/deprecated and does not become current-host wording.

Risks:
- A partial enum update could make probe pass while dispatch policy still rejects the host.
- Copying live-dispatch semantics could overclaim unattended support for `agy`.

## CHK-002

Update dispatch policy and runtime surfaces for the current three-host set.

Implementation steps:
- Update policy known-host validation to include Antigravity and the `agy` alias behavior.
- Update host runtime list/probe/status text and user-facing error messages so the current real hosts are Codex CLI, Claude Code CLI, and Antigravity CLI.
- Update README/guide/host-overflow/lattice-parallel-wave references that present Gemini as the current third host; leave only explicitly legacy/deprecated mentions where needed.
- Do not broaden Authority Server, lifecycle, or production completion semantics.

Verification:
- `node bin/lattice.js host_runtime_list --json` includes Antigravity with command `agy`.
- Dispatch policy creation/checking accepts `antigravity` where current real hosts are allowed.
- Documentation grep confirms current-host examples use Antigravity/agy rather than Gemini-first wording.

Risks:
- Docs and runtime could drift if only one side is updated.
- Legacy Gemini compatibility could be misread as the current recommended host.

## CHK-003

Verify agy host detection and legacy Gemini behavior.

Implementation steps:
- Add or update focused tests/smokes around runtime normalization, host probe/list, and dispatch policy validation.
- Run local command checks against installed `agy` without invoking direct Gemini CLI.
- Record verification evidence for each happy, edge, and adversarial intent.

Verification:
- `agy --version` proves the local binary exists.
- Build passes with `npm --prefix packages/main run build`.
- Focused host-runtime smoke commands pass and produce stable JSON.
- Legacy Gemini behavior is checked only through Lattice CLI surfaces, not direct `gemini` execution.

Risks:
- Test coverage may only prove availability on this machine and miss missing-binary behavior. Use command-path abstraction or existing probe fallback to cover unavailable CLI behavior if available.

## Out of scope

- Full removal of every Gemini provider/usage-ledger implementation.
- Large cli-engine.ts modularization; that is split into B-74a0, B-a776, B-6e69, and B-57b5.
- Authority Server receipt-gate changes.
- Remote git push or release.
