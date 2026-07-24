# Plan: B-a539 Remove duplicated reviewer-scan-budget smoke entry from validate.commands

## CHK-001: Delete the duplicate bare-string validate.commands entry and keep the focus-tagged object

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: lattice.config.json (validate.commands only)
- Create: none
- Test: none (config-only change; verification is scripted in CHK-002)

**Verify**:
- `grep -c reviewer-scan-budget-guard-smoke lattice.config.json` prints `1`
- `node -e "JSON.parse(require('fs').readFileSync('lattice.config.json','utf8'))"` exits 0
- A node one-liner comparing the pre-edit and post-edit normalised command lists shows exactly one removal (the bare string `node packages/main/dist/tasks/reviewer-scan-budget-guard-smoke.js`) and no other difference
- Filtering `validate.commands` by `focus` containing `fast` still yields an entry for the smoke

**DoneWhen**:
- `validate.commands` has 47 entries (was 48)
- The single surviving smoke entry is `{"command":"node","args":["packages/main/dist/tasks/reviewer-scan-budget-guard-smoke.js"],"focus":["fast"]}`
- It declares no `shell`, `cwd`, `env`, `timeoutMs` or `optional`, exactly as before the edit
- No other entry in the list is added, removed, reordered or reworded

## CHK-002: Prove from validate invocation records that the smoke runs exactly once and rescan for other duplicates

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: none
- Create: none
- Test: read-only verification via the validate runner's own invocation record

**Verify**:
- Run `lattice validate --json` from the story worktree and count command results whose command line references `reviewer-scan-budget-guard-smoke.js`; the count must be exactly 1
- A full-identity duplicate scan (serialising command, args, shell, cwd, env, timeoutMs, optional, focus) over all `validate.commands` entries reports zero duplicate groups
- A separate same-script scan reports any remaining pairs sharing a script path; each such pair must differ in meaningful execution parameters and must be left in place

**DoneWhen**:
- The invocation record shows exactly one execution of the smoke, and that execution passes
- The full-identity scan reports no duplicates
- The same-script scan confirms nothing with differing execution parameters was removed
