# B-e28c Plan

## Scope
Fix only the public CLI bug where server-backed Authority job status reads omit the configured customer API key. Keep policy discovery unauthenticated and keep receipt/quorum completion semantics unchanged.

## CHK-001: Authorize protected job status GET

**Owner**: main-agent

**Do**: Add an explicit authenticated GET path or option in the Authority client for protected job verdict/status reads. Use the existing resolved customer API key from server-backed Authority config. Apply it to `listJobVerdicts`/`authority_job_status` as needed.

**Do Not**: Do not add Authorization to `GET /v1/authority/policy`. Do not change local fallback behavior, receipt verification, or multi-host quorum calculations. Do not touch generated senior key/env files.

**Verify**: Smoke assertions must show protected `/v1/jobs/<jobId>/verdicts` GET carries `Authorization: Bearer <customer-key>` while policy discovery remains keyless.

## CHK-002: Add smoke coverage for the regression

**Owner**: main-agent

**Do**: Extend `authority-client-smoke.ts` to cover the reported 401 class and the product-reviewer advisory: a successful protected status read with no verified receipt/quorum must still report `authorityDone=false` and `fullAuthorityDone=false`.

**Do Not**: Do not make transport success imply productionDone/fullAuthorityDone. Do not change server contracts or bundle-generation behavior.

**Verify**: Run `npm --prefix packages/main run build` and `node packages/main/dist/tasks/authority-client-smoke.js`.
