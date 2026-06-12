## Trigger Event
B-3938 exposed a real wrapper-root failure mode on 2026-06-12: metadataRoot was /Users/jek/Documents/ClawCreek while the git repository lived under /Users/jek/Documents/ClawCreek/clawcreek. story_resolve and review_run_start now explain the failure, but the user still has to infer the exact config repair manually.

## Key Insights
The correctness issue is not that Lattice should guess a signed workspace at runtime. The issue is that Lattice can deterministically diagnose a common wrapper-root layout and produce an explicit operator-confirmed repair path. That keeps the authority boundary in the CLI and keeps Claude, Codex, or any other host neutral.

## Solution Tradeoffs
We choose a small config doctor plus config repair UX instead of automatic host-agent repair or silent nested repo discovery. Single immediate child git repo can be suggested because it is an operator-facing diagnostic, not an automatic resolution. Multiple candidates must remain fail-closed.

## Conversational Texture
The user asked whether long-term UX should automatically let host agents fix the layout. The agreed answer is no: host agents may execute a visible Lattice command, but Lattice must own the policy, validation, config write, and evidence so the fix remains deterministic and auditable.
