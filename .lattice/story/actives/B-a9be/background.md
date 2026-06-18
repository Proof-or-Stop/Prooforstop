## Trigger Event
On 2026-06-18, B-META-framework-audit findings F-012 and F-013 stayed open because CLAUDE.md still points readers to lattice serve --web / --cli, even though lattice serve --help only shows --dev and --port. This is a docs drift issue, not a runtime feature gap, and it is visible in the current B-META audit trail.

## Key Insights
The stale guidance lives in a user-facing onboarding file, so the mismatch can keep spreading even if the implementation is correct. The fix should stay narrow: correct the documented command surface and remove implied npm scripts that do not exist in package.json, without changing the serve implementation itself.

## Solution Tradeoffs
We should prefer the smallest doc edit that makes the guidance truthful, because overexplaining alternate shells or speculative wrapper commands would create more drift. The story should explicitly avoid code changes unless a verification step discovers the docs reference a real command that is currently hidden from help output.

## Conversational Texture
This is one of those quiet-but-important cleanup tasks where the right result is simply that a future reader stops being misled. The goal is to make the path obvious and boring in the best way: one documented serve surface, one consistent startup example, no phantom flags.
