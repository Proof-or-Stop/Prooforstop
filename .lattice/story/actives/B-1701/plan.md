# Plan: B-1701 Authority trust profile bundle generator

## CHK-001: Add default bundle generator

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/lattice-cli.ts, packages/main/src/core/authority-mode.ts, packages/main/src/core/authority-client.ts
- Create: none
- Test: packages/main/src/tasks/authority-client-smoke.ts, packages/main/src/tasks/authority-status-smoke.ts

**Verify**:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/authority-client-smoke.js`
- `node packages/main/dist/tasks/authority-status-smoke.js`

**DoneWhen**:
- The default bundle path writes `lattice_authority_trust.env` and `lattice_staging-client.env`.
- No extra developer fields are required for the basic bundle.
- The generated bundle can be sourced cleanly by the existing Authority config loader.

## CHK-002: Preserve compatibility

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/lattice-cli.ts, packages/main/src/core/authority-mode.ts, packages/main/src/core/authority-client.ts
- Create: none
- Test: packages/main/src/tasks/authority-client-smoke.ts, packages/main/src/tasks/authority-status-smoke.ts

**Verify**:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/authority-client-smoke.js`
- `node packages/main/dist/tasks/authority-status-smoke.js`

**DoneWhen**:
- Legacy `authority_trust.env` and `staging-client.env` remain usable as compatibility aliases.
- Existing automation that reads the legacy names does not need to change.
- The new names and old names stay in sync with the same underlying contents.

## CHK-003: Enable senior bundle path

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/lattice-cli.ts, packages/main/src/core/authority-mode.ts, packages/main/src/core/authority-client.ts
- Create: none
- Test: packages/main/src/tasks/authority-client-smoke.ts, packages/main/src/tasks/authority-status-smoke.ts

**Verify**:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/authority-client-smoke.js`
- `node packages/main/dist/tasks/authority-status-smoke.js`

**DoneWhen**:
- Senior mode is explicit opt-in and emits `lattice_senior_authority_trust.env` plus `lattice_senior_staging-client.env`.
- Leaving senior mode off keeps the basic bundle as the default output.
- The senior path never becomes the silent default or requires extra developer fields.

## CHK-004: Update docs

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: docs/requirements/decisions/lattice-authority-customer-api-key-access.md, docs/guide.md, README.md
- Create: none
- Test: packages/main/src/tasks/docs-drift-path-drift-smoke.ts, packages/main/src/tasks/authority-client-smoke.ts

**Verify**:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:docs-drift-smoke`

**DoneWhen**:
- Docs explain the default bundle, the explicit senior variant, and the legacy alias path together.
- Examples use the same filenames that the generator emits.
- The docs do not reintroduce the old Koala wording or a second protocol.
