# B-0888 Execution Plan

## CHK-001 Remove project dev-memory legacy brand text and tags

**Owner**: lattice-implementer

**Goal**: Rewrite tracked project dev-memory entries so they contain current Proofbound/Lattice guidance only. Remove old-brand prose and old-brand search tags from `.lattice/dev-memory/experience.jsonl`, while keeping useful lessons and host-policy entries.

**Steps**:
- Read current project dev-memory rows and identify entries containing old brand text or old-brand tags.
- Rewrite those rows to current Proofbound/Lattice wording.
- Remove old-brand search tags and old evidence refs that exist only to support legacy compatibility.
- Preserve current host-policy rows and non-authoritative flags.

**Verify**:
- `rg 'Koala|koala|\.koala' .lattice/dev-memory` returns no matches.
- `lattice dev_memory_list --scope=project --limit=100` contains current Proofbound/Lattice lessons and host-policy rows.

## CHK-002 Remove global old legacy memory rows

**Owner**: lattice-implementer

**Goal**: Physically remove global dev-memory rows that contain old brand text or `.koala` references. Do not delete unrelated current global lessons.

**Steps**:
- Inspect `/Users/jek/.lattice/dev-memory/experience.jsonl`.
- Remove only rows whose serialized JSON contains old brand text or `.koala` refs.
- Preserve unrelated rows such as stale-doc lessons and host taxonomy memories.

**Verify**:
- `rg 'Koala|koala|\.koala' /Users/jek/.lattice/dev-memory/experience.jsonl` returns no matches.
- `lattice dev_memory_list --scope=global --limit=100` still shows unrelated current memories.

## CHK-003 Update dev-memory smoke to assert physical cleanup

**Owner**: lattice-implementer

**Goal**: Update `packages/main/src/tasks/dev-memory-supersession-smoke.ts` so the policy being tested is physical cleanup rather than legacy-readable supersession retention.

**Steps**:
- Remove expectations that old rows remain readable or that legacy search tags exist.
- Add assertions that project/global memory outputs contain no old brand terms.
- Keep assertions that current Proofbound/Lattice and host-policy memories remain available and non-authoritative.

**Verify**:
- `node packages/main/dist/tasks/dev-memory-supersession-smoke.js` passes.
- The smoke fails if old-brand tags, prose, command names, or `.koala` refs are reintroduced.

## CHK-004 Verify memory cleanup and runtime tests

**Owner**: lattice-implementer

**Goal**: Prove the cleanup from the user's perspective and through existing runtime gates.

**Steps**:
- Build the package.
- Run the updated dev-memory smoke.
- Run the residue scanner.
- Run direct project/global memory scans and search/list checks.
- Run broader tests if practical before DONE-required validation.

**Verify**:
- `npm --prefix packages/main run build` passes.
- `node packages/main/dist/tasks/dev-memory-supersession-smoke.js` passes.
- `npm run test:lattice-residue` passes.
- `rg 'Koala|koala|\.koala' .lattice/dev-memory /Users/jek/.lattice/dev-memory/experience.jsonl` returns no matches.
