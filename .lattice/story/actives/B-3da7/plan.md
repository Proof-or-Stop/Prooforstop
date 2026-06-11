# Plan: B-3da7 Fix authority policy smoke task annotation compliance

## CHK-001 Add missing @changes field to authority policy smoke @task header

1. Ask Claude Code CLI implementer to edit only the file header in `packages/main/src/tasks/authority-enforce-policy-smoke.ts`.
2. Add a parser-compatible `@changes` field describing the M1 read-only policy discovery smoke coverage without claiming production authority enforcement.
3. Verify the diff is comment-only.
4. Run `node packages/main/dist/tasks/cli-validate.js` and confirm `Errors: 0`.
5. Run `npm --prefix packages/main run test:authority-enforce-policy` and `npm --prefix packages/main run build` to prove the annotation change did not break the smoke or TypeScript build.
6. Run `koala convergence_check` and confirm code annotation compliance passes.
