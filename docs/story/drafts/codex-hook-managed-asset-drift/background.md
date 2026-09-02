## Trigger Event
During B-d854 validation on 2026-09-02, `node bin/proof-or-stop.js check --json` reported two pre-existing generated Codex hook files as `STALE_SAFE` while `doc:AGENTS.md` itself was `OK`.

## Key Insights
The affected paths are `.codex/hooks/proof-or-stop-scope-pretool.cjs` and `.codex/hooks/proof-or-stop-evidence-pretool.cjs`. Their managed generated signatures make replacement mechanically safe, but neither file is inside B-d854's single-file scope and the drift does not block the AGENTS.md translation acceptance.

## Solution Tradeoffs
Applying `check --apply` now would widen B-d854 and mix hook-runtime changes with a documentation-only review. Deferring preserves review isolation; the tradeoff is that the overall managed-asset check remains false until the generated assets are refreshed and adapter verification is rerun.

## Conversational Texture
The user requires medium or low nonblocking defects to retain reproduction, evidence, impact, recommendation, and follow-up ownership instead of being dismissed orally. The follow-up owner should review the generated diff, replace only these safe assets, run `proof-or-stop codex verify` and `proof-or-stop check --json`, and record the resulting evidence.
