# B-7fc2 User Acceptance Transcript Diff

Story: B-7fc2 - Keep Lattice CLI --json stdout machine-parseable while preserving human hints
Phase: TEST
Tested head: 664d31c885db8e39005c5352b6b418bf5ed7e0a9

## Expected outcome from PLAN

1. Machine JSON mode:

```sh
node packages/main/dist/cli.js validate --json | node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(0,"utf8")); console.log("parse-ok")'
```

Expected: `parse-ok`.

2. Text mode:

```sh
node packages/main/dist/cli.js validate
```

Expected: human next-step hint remains visible, including `验证全绿`.

3. Regression smoke:

```sh
npm --prefix packages/main run test:cli-json-stdout-contract-smoke
```

Expected: smoke passes and proves direct `JSON.parse(stdout)` for JSON mode.

## Actual transcript

1. Story validate JSON mode with direct parser:

```sh
set -o pipefail
KOALA_SESSION_ID=codex-b7fc2 node packages/main/dist/cli.js validate --story=B-7fc2 --json 2>/tmp/b7fc2-test-json-stderr.txt \
  | node -e 'const fs=require("fs"); const s=fs.readFileSync(0,"utf8"); const parsed=JSON.parse(s); console.log(JSON.stringify({parse:"ok", allPass: parsed.allPass, status: parsed.status, coverage: `${parsed.verificationCoverage.covered}/${parsed.verificationCoverage.total}`}, null, 2));'
```

Actual:

```json
{
  "parse": "ok",
  "allPass": true,
  "status": "pass",
  "coverage": "12/12"
}
```

Stderr tail contained only config/progress diagnostics:

```text
Reading legacy koala.config.json...
running validate...
running 1 advisory fallback validation command(s)
ran: npm test
validate done
```

2. Story validate text mode:

```sh
KOALA_SESSION_ID=codex-b7fc2 node packages/main/dist/cli.js validate --story=B-7fc2 | tail -n 10
```

Actual tail included verification coverage lines and the human hint:

```text
Verification intent coverage: 12/12 covered (0 required missing)
...
验证全绿。下一步：运行 lattice next 或 lattice session_brief 查看 DONE pre-check；全部通过后 lattice story_advance --storyId=B-7fc2 --phase=DONE，未通过先补 gate
```

3. Focused regression smoke:

```sh
npm --prefix packages/main run test:cli-json-stdout-contract-smoke
```

Actual:

```text
> @koala-agent/core@0.3.5 test:cli-json-stdout-contract-smoke
> node dist/tasks/cli-json-stdout-contract-smoke.js

cli json stdout contract smoke passed
```

4. Full story validate:

```sh
KOALA_SESSION_ID=codex-b7fc2 node packages/main/dist/cli.js validate --story=B-7fc2 --json
```

Actual:

- `status`: `pass`
- `allPass`: `true`
- verification intent coverage: `12/12`
- fallback project test command `npm test` passed

## Diff assessment

Expected and actual match for the scoped contract:

- JSON mode stdout is a single direct-parseable JSON document.
- Human next-step guidance remains in text mode.
- The focused smoke locks the direct-parse behavior and hint-marker absence.
- No dashboard or adapter substring parser is required.

Operational note:

- The global `lattice` binary currently resolves to the main checkout dist, not this story worktree. For this story acceptance, commands intentionally use `node packages/main/dist/cli.js` from the worktree. After merge/build on main, the global binary will see the same implementation.

Residual limitations:

- No known limitation for the B-7fc2 stdout contract.
- This story does not finalize every dashboard/resolver JSON schema; host-neutral observability M1+ still owns resolver and adapter schema expansion.
