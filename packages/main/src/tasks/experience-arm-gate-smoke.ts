#!/usr/bin/env node
// experience-arm-gate-smoke.ts — hermetic acceptance smoke for the control-arm
// memory ISOLATION layer that sits on top of main's experiment-arm render gate.
//
// The RENDER gate (surfaceRuntimeMemoryPack / resolveExperimentArm, keyed on
// LATTICE_EXPERIMENT_ARM / LATTICE_EXPERIMENT_ID) is main's (B-ab8d) and is
// covered by experiment-arm-smoke.ts + experience-pack-arm-switch-smoke.ts.
// This smoke covers the two things layered on top, both keyed on the SAME
// resolver:
//   CHK-A  isControlArm — boolean probe of the resolved arm (LATTICE_* env).
//   CHK-B  redactMemoryPackForControlArm — control empties results/items arrays,
//          nulls sourceDigests fingerprints, collapses packDigest, and FAILS
//          CLOSED on a throwing pack; treatment/normal are byte-identical.
//   CHK-D  renderHostDispatchProjectionText omits the memory block on control.
// The control-arm retrieval COMMAND block is main's (command-policy.ts
// memoryRetrieval marker), covered by experience-pack-arm-switch-smoke.ts.
// No fs/network.

import { isControlArm, packDigest, redactMemoryPackForControlArm } from '../core/runtime-memory-arm-gate.js';
import { renderHostDispatchProjectionText } from '../core/lattice-handoff.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// main's resolver reads LATTICE_EXPERIMENT_ARM / LATTICE_EXPERIMENT_ID.
const CONTROL = { LATTICE_EXPERIMENT_ARM: 'control', LATTICE_EXPERIMENT_ID: 'exp1' };
const TREATMENT = { LATTICE_EXPERIMENT_ARM: 'treatment', LATTICE_EXPERIMENT_ID: 'exp1' };

// --- CHK-A: isControlArm ------------------------------------------------------
check('CHK-A isControlArm true only for a control-arm env', isControlArm(CONTROL) === true);
check('CHK-A isControlArm false on treatment', isControlArm(TREATMENT) === false);
check('CHK-A isControlArm false with no experiment env', isControlArm({}) === false);
check('CHK-A isControlArm false when only the arm is set (id missing)',
  isControlArm({ LATTICE_EXPERIMENT_ARM: 'control' }) === false);
check('CHK-A isControlArm false for an unknown arm value',
  isControlArm({ LATTICE_EXPERIMENT_ARM: 'shadow', LATTICE_EXPERIMENT_ID: 'e' }) === false);

// --- CHK-B: redactMemoryPackForControlArm ------------------------------------
{
  const makePack = () => ({
    schemaVersion: 'proofbound.memory-pack.v1',
    packDigest: packDigest(['pb-x', 'lesson-y']),
    results: { devMemoryEntryIds: ['lesson-y'], playbookIds: ['pb-x'], suppressedSupersededIds: [], deprecatedTermHits: [], contributingSourceRefs: ['ref-1'] },
    items: { devMemory: [{ id: 'lesson-y' }], playbooks: [{ id: 'pb-x' }] },
    sourceDigests: { projectDevMemoryDigest: 'proj-fp', globalDevMemoryDigest: 'glob-fp', playbookDigest: null, signatureRegistryDigest: 'sig-fp' },
    authority: 'non_authoritative', gateEvidence: false,
  });
  const emptyDigest = packDigest([]);
  const control = redactMemoryPackForControlArm(makePack(), CONTROL);
  const treatment = redactMemoryPackForControlArm(makePack(), TREATMENT);
  const normal = redactMemoryPackForControlArm(makePack(), {});
  const arraysEmpty = (p: any) =>
    Object.values(p.results).every((v) => !Array.isArray(v) || v.length === 0) &&
    Object.values(p.items).every((v) => !Array.isArray(v) || v.length === 0);
  check('CHK-B control: every result/item array emptied', arraysEmpty(control));
  check('CHK-B control: packDigest collapsed to the content-free empty-set digest',
    control.packDigest === emptyDigest && control.packDigest !== makePack().packDigest);
  check('CHK-B control: sourceDigests corpus fingerprints nulled',
    Object.values((control as any).sourceDigests).every((v) => v === null) &&
    !JSON.stringify(control).includes('proj-fp') && !JSON.stringify(control).includes('sig-fp'));
  check('CHK-B control: no stored id survives anywhere in the serialized pack',
    !JSON.stringify(control).includes('pb-x') && !JSON.stringify(control).includes('lesson-y'));
  check('CHK-B treatment: pack returned byte-identical (memory preserved)',
    JSON.stringify(treatment) === JSON.stringify(makePack()));
  check('CHK-B normal (no experiment): pack returned byte-identical',
    JSON.stringify(normal) === JSON.stringify(makePack()));
  check('CHK-B non-control: a non-pack object is returned unchanged (treatment/normal)',
    (redactMemoryPackForControlArm({ foo: 1 } as any, TREATMENT) as any).foo === 1);
  // fail CLOSED on control: a throwing pack still yields empty surfaces.
  const boobyPack: any = { packDigest: packDigest(['x']), items: { d: [] } };
  Object.defineProperty(boobyPack, 'results', { enumerable: true, get() { throw new Error('boom'); } });
  const failClosed = redactMemoryPackForControlArm(boobyPack, CONTROL) as any;
  check('CHK-B control fail-CLOSED: a throwing pack yields empty surfaces + empty-set digest',
    failClosed.packDigest === emptyDigest &&
    JSON.stringify(failClosed.items) === '{}' &&
    !Object.getOwnPropertyDescriptor(failClosed, 'results')?.get);
}

// --- CHK-D: control-arm TEXT omission at renderHostDispatchProjectionText ------
{
  const memPack = {
    schemaVersion: 'proofbound.memory-pack.v1',
    packDigest: packDigest(['pb1', 'dm1']),
    results: { playbookIds: ['pb1'], devMemoryEntryIds: ['dm1'], suppressedSupersededIds: [], deprecatedTermHits: [], contributingSourceRefs: [] },
    items: { devMemory: [], playbooks: [] },
    authority: 'non_authoritative', gateEvidence: false,
  };
  const projection = {
    schemaVersion: 'lattice.host_dispatch.v1', status: 'planned', mode: 'supervised',
    storyId: 'B-t', host: 'codex', packId: 'HP-x', packHash: 'sha256:x', overflowReady: false,
    nextAction: 'review', limits: [], warnings: [],
    admissibilitySummary: { admissibleProofRef: [], blocked: false, diagnostics: [], reasons: [] },
    worktree: { worktreePath: '/tmp/x', branch: 'b' },
    prefetchManifest: { verdict: 'no-block', winSignal: 'ready', targetStoryId: 'B-t', staleSignals: [] },
    preflight: { memoryFreshnessPack: memPack },
  } as any;
  const underArm = (arm: string | null, fn: () => string): string => {
    const A = 'LATTICE_EXPERIMENT_ARM', I = 'LATTICE_EXPERIMENT_ID';
    const oa = process.env[A], oi = process.env[I];
    if (arm) { process.env[A] = arm; process.env[I] = 'e'; } else { delete process.env[A]; delete process.env[I]; }
    try { return fn(); } finally {
      oa === undefined ? delete process.env[A] : (process.env[A] = oa);
      oi === undefined ? delete process.env[I] : (process.env[I] = oi);
    }
  };
  const render = () => renderHostDispatchProjectionText(projection);
  const control = underArm('control', render);
  const treatment = underArm('treatment', render);
  const normal = underArm(null, render);
  const hasMem = (s: string) => /memoryPackDigest:|memoryTopHitIds:/.test(s);
  check('CHK-D control: host_dispatch text OMITS the memory block (no digest/top-hit lines)', !hasMem(control));
  check('CHK-D treatment: host_dispatch text SHOWS the digest + real top-hit ids',
    hasMem(treatment) && treatment.includes(memPack.packDigest) && treatment.includes('pb1, dm1'));
  check('CHK-D normal (no experiment): host_dispatch text SHOWS the memory block (unchanged)',
    hasMem(normal) && normal.includes(memPack.packDigest));
  check('CHK-D control render leaks no stored id anywhere', !control.includes('pb1') && !control.includes('dm1'));
}

if (failures > 0) { console.error(`${failures} smoke failure(s)`); process.exit(1); }
console.log('experience-arm-gate smoke: all cases passed');
