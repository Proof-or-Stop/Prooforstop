## Trigger Event
2026-06-19 user clarified that the current three Host runtimes are Codex CLI, Claude Code CLI, and Antigravity CLI with command agy; Gemini CLI wording is deprecated and should not be used as current semantics. Existing host_runtime_probe rejects antigravity and still advertises gemini.

## Key Insights
The gap is runtime behavior, not only documentation. Host ids are hard-coded in probe, list, dispatch, and policy validation surfaces, so Antigravity must be added through the same mechanical contract used by Codex and Claude Code.

## Solution Tradeoffs
A narrow host-runtime story should land before the larger cli-engine split because it unlocks reliable multi-host verification and has limited blast radius. Gemini can remain as legacy compatibility only where removing it would break existing records, but it must stop being presented as the active third host.

## Conversational Texture
The user wants development to start now, with multiple host宿主参与 and a clear move away from old Gemini semantics. This story is the first enabling slice before parallel cli-engine refactor stories are driven by separate hosts.
