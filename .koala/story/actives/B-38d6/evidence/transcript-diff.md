# B-38d6 User Acceptance Transcript Diff

Date: 2026-06-03

CLI under test: `packages/main/dist/cli.js validate --json`

## Expected

- A repo containing only `Package.swift` must not auto-run `swift test`; validation should return a no-validation-entry warn/skip result with zero commands.
- `lattice.config.json` is the canonical project config and configured `validate.commands` run from it.
- Legacy `koala.config.json` remains readable as a fallback and emits a migration diagnostic.
- If both `lattice.config.json` and `koala.config.json` exist, `lattice.config.json` wins and the legacy command is not executed.

## Actual Transcript Summary

All four acceptance cases matched expected output.

| Case | Provider | Status | Commands | User-visible result |
| --- | --- | --- | --- | --- |
| `Package.swift` only | `koala-verifier-no-validation-entry` | `warn` | `0` | Details state Swift / Package.swift is not in automatic fallback because Mac Native App is retired; explicit `validate.commands` is required for `swift test`. |
| `lattice.config.json` canonical | `koala-verifier-configured-commands` | `pass` | `lattice acceptance` | Output contained `lattice-ok`. |
| `koala.config.json` legacy fallback | `koala-verifier-configured-commands` | `pass` | `legacy acceptance` | Output contained `legacy-ok`; stderr included the legacy config migration notice. |
| Both configs present | `koala-verifier-configured-commands` | `pass` | `lattice wins` | Output contained `lattice-wins`; output did not contain `legacy-loses`; stderr stated `lattice.config.json` is canonical. |

Representative `Package.swift`-only user-visible output:

```json
{
  "provider": "koala-verifier-no-validation-entry",
  "status": "warn",
  "allPass": true,
  "summary": "No project validator configured; skipped project-specific validation",
  "details": [
    "未找到 validate.ts/js/mts，也未在 lattice.config.json / koala.config.json 配置 validate.command(s)",
    "未自动发现 npm test / pytest / go test / cargo test / mvn test / gradle test 等 fallback 标准入口",
    "Swift / Package.swift 不在自动 fallback 列表（Mac Native App 已退役）；如需运行 swift test，请显式配置 validate.commands。"
  ],
  "commands": []
}
```

Representative conflict-case user-visible output:

```text
stderr: lattice.config.json and legacy koala.config.json both exist; using lattice.config.json (canonical).
stdout: lattice-wins
```

## Outcome Diff

No user-facing acceptance gap remains. Expected and actual behavior match for Swift fallback removal and Lattice config canonicalization.

## Pitfalls

The worktree-local `bin/lattice.js` path was not used for these isolated temp-repo acceptance checks because local bootstrap requires `packages/utils/dist/index.js`. The bootstrap diagnostic explicitly recommends `node packages/main/dist/cli.js <command>` as the core-only local CLI fallback, so the acceptance run used that entrypoint.

`validate --json` currently writes a JSON object followed by the human line `→ 验证全绿。可以提交`. The acceptance parser therefore extracted the first JSON object and preserved the trailing line as part of the real transcript.
