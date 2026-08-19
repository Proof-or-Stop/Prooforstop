## Trigger Event
On 2026-06-23 the user clarified that host declaration means each developer agent host, such as Codex CLI, Claude Code, or a future host, should be able to declare itself when running or taking over Authority work.

## Key Insights
The CLI must not treat provider identity as a closed product enum for Authority routing. The server policy, actor key, customer credential, runner session, and signed claim remain the real authorization boundaries.

## Solution Tradeoffs
Keep the change narrow: accept and propagate host-neutral declaration strings where Authority runner flows need them, while preserving existing adapter-specific execution mapping for known local providers.

## Conversational Texture
The user wants this to be simple for developers receiving the generated bundle, so the CLI should avoid surprising enum failures and should surface clear diagnostics when server-side policy rejects a declaration.
