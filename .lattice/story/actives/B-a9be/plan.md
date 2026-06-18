# B-a9be Plan

This story is intentionally narrow: fix the stale serve documentation that still mentions unsupported `--web` / `--cli` modes, then refresh the framework audit so the open drifts close from the corrected sources. No runtime behavior should change.

## CHK-001
- Update the `CLAUDE.md` "三种运行模式" prose so it only describes the supported `lattice serve` surface: `--dev` and `--port`.
- Sync the top comment in `packages/main/src/verifier/dev-cli.ts` to the same truthful surface so the source copy does not keep the stale `--web` / `--cli` wording alive.
- Keep the existing non-serve onboarding guidance intact; this item is only about the misleading serve-mode description.
- Validation: `rg -n "serve:web|serve:cli|--web|--cli" CLAUDE.md packages/main/src/verifier/dev-cli.ts` should show no stale serve-mode aliases in the edited text, and `lattice audit --framework` should no longer report these flags as drift for `CLAUDE.md#三种运行模式`.

## CHK-002
- Rewrite the `CLAUDE.md` startup command block so it uses only supported lattice invocations: `lattice serve`, `lattice serve --dev="npx vite"`, and `--port` if an explicit port example is needed.
- Remove the non-existent `npm run serve`, `npm run serve:web`, and `npm run serve:cli` examples so the block does not teach commands that `package.json` never defines.
- Do not replace the block with a longer explanation; the desired outcome is one short truthful command surface that is easy to copy.
- Validation: `rg -n "npm run serve:web|npm run serve:cli|lattice serve --web|lattice serve --cli" CLAUDE.md` should find no unsupported serve aliases, and the regenerated framework audit report should reflect zero remaining serve-mode drift in that section.
