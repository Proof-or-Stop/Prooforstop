# Framework Audit Report — round 8 (2026-06-18)

- new drift: 0
- still-drifting: 2
- resolved-by-nature: 0
- skipped: 1

## Drifts

| drift-type | section-path | symbol | severity | status | firstSeenRound | lastSeenAt |
|---|---|---|---|---|---|---|
| missing-flag | CLAUDE.md#三种运行模式 | lattice serve --web | medium | still-drifting | 7 | 2026-06-18T10:59:00.673Z |
| missing-flag | CLAUDE.md#三种运行模式 | lattice serve --cli | medium | still-drifting | 7 | 2026-06-18T10:59:00.674Z |

## Resolved this round (drift cleared)

_none_

## Skipped

| drift-type | section-path | symbol | reason |
|---|---|---|---|
| missing-command | CLAUDE.md#框架自省 audit 配置 | lattice audit_config_set | explicit-yagni-whitelist |
