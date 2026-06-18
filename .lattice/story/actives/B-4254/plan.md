# Plan: B-4254 Remove hidden serve launcher compatibility flags

## CHK-001: Remove legacy --web / --cli compatibility parsing from the dev launcher

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/verifier/dev-cli.ts
- Test: packages/main/src/verifier/dev-cli.ts, npm --prefix packages/main run build

**Verify**:
- `npm --prefix packages/main run build`
- `node -e "const fs=require('fs'); const text=fs.readFileSync('packages/main/src/verifier/dev-cli.ts','utf8'); if (text.includes('--web') || text.includes('--cli')) throw new Error('legacy flags still present'); console.log('legacy aliases removed');"`

**DoneWhen**:
- `packages/main/src/verifier/dev-cli.ts` no longer branches on `--web` or `--cli`
- the supported serve launch flow still builds successfully
- the launcher source reflects only the documented serve surface

## CHK-002: Add a regression check for the launcher contract

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: scripts/verify-entrypoints.mjs
- Test: npm run test:entrypoints

**Verify**:
- `npm run test:entrypoints`
- the script ends with `entrypoints verified`
- the check would fail if the old launcher aliases return

**DoneWhen**:
- the root entrypoint smoke guards the dev launcher contract
- a future reintroduction of `--web` / `--cli` causes the entrypoint check to fail
- the test still passes on the supported serve surface only
