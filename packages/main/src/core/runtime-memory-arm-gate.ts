// runtime-memory-arm-gate.ts — control-arm memory ISOLATION helpers.
//
// The experiment-arm RENDER gate (compute the pack on both arms, fire the
// `experience_pack_surfaced` event, and suppress the rendered section on the
// control arm) is owned by core/experience-pack-surface.ts (surfaceRuntimeMemoryPack)
// keyed on core/experiment-arm.ts (resolveExperimentArm, LATTICE_EXPERIMENT_ARM /
// LATTICE_EXPERIMENT_ID). This module adds the two things that render-gate does
// NOT cover, both keyed on the SAME resolver so the whole isolation is coherent:
//
//   1. isControlArm(env) — a boolean probe of the resolved experiment arm, used
//      by the control-arm memory-RETRIEVAL command block (command-policy.ts) and
//      by the handlers that must fully OMIT a memory section on control.
//   2. redactMemoryPackForControlArm(pack) — empties a MemoryFreshnessPack's
//      host-visible surfaces (results/items arrays, sourceDigests fingerprints,
//      packDigest) on the control arm so no memory leaks through a JSON/file
//      serialization (done_closure --json, final_response_check, handoff /
//      host_dispatch projections, playbook_runtime_health). surfaceRuntimeMemoryPack
//      only gates the TEXT render; these are the non-render leak surfaces.
//
// CONTROL-ARM ISOLATION BOUNDARY (what the control-arm isolation covers):
//   IN  — LIVE runtime memory surfacing: the runtime memory pack rendered
//         (surfaceRuntimeMemoryPack) OR serialized (redactMemoryPackForControlArm)
//         at the lifecycle consumers + handoff / host_dispatch / done_closure /
//         final_response_check surfaces; the memory-RETRIEVAL command set
//         (CONTROL_ARM_RETRIEVAL_BLOCK, refused on control); and LIVE experience
//         injection into parallel dispatch (experienceRefs).
//   OUT — STORED historical evidence: test-evidence.output and
//         canonicalStory.evidence[].output exported by story_export / test_list /
//         handoff_create can contain a Memory Runtime Preflight recorded at an
//         earlier DEV time. This is replayed audit data, not live retrieval. For
//         REAL control-arm experiment stories the recording points above are
//         gated, so their stored evidence is already memory-free — the leak only
//         appears for stories developed OUTSIDE the experiment (F-022 decision).

import { createHash } from 'node:crypto';
import { resolveExperimentArm } from './experiment-arm.js';

/**
 * True ONLY when the resolved experiment arm is 'control'. Never throws — a
 * resolver error defaults to false (normal work / treatment are unaffected;
 * the fail-open direction OUTSIDE control). Reads LATTICE_EXPERIMENT_ARM /
 * LATTICE_EXPERIMENT_ID via resolveExperimentArm.
 */
export function isControlArm(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  try {
    return resolveExperimentArm(env as NodeJS.ProcessEnv)?.arm === 'control';
  } catch {
    return false;
  }
}

/** Order-independent stable sha256 of an id set (used for the empty-set digest). */
export function packDigest(surfacedIds: string[]): string {
  return createHash('sha256').update(JSON.stringify([...surfacedIds].sort())).digest('hex');
}

/** Digest of the empty surfaced-set — the content-free value shown on control. */
const EMPTY_PACK_DIGEST = packDigest([]);

/**
 * Redact a runtime-memory pack for the control arm so NO host-visible serialized
 * surface — a raw JSON pack object, its packDigest fingerprint, top-hit ids, or
 * sourceDigests corpus fingerprints — can leak stored memory to a control-arm
 * host. Returns the pack unchanged for normal work and the treatment arm; on the
 * control arm returns a structurally valid pack with EMPTY results/items, nulled
 * sourceDigests, and the empty-set packDigest. Applied at each JSON/file surface
 * (the TEXT render is separately gated by surfaceRuntimeMemoryPack's shouldRender).
 */
export function redactMemoryPackForControlArm<T extends { results?: any; items?: any; packDigest?: any; sourceDigests?: any }>(
  pack: T,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): T {
  if (!isControlArm(env)) return pack;
  // On the control arm, redaction MUST fail CLOSED (F-018): any internal error
  // returns a structurally-empty pack, never the populated one.
  try {
    const emptyResults = pack.results && typeof pack.results === 'object'
      ? Object.fromEntries(Object.entries(pack.results).map(([k, v]) => [k, Array.isArray(v) ? [] : v]))
      : pack.results;
    const emptyItems = pack.items && typeof pack.items === 'object'
      ? Object.fromEntries(Object.entries(pack.items).map(([k, v]) => [k, Array.isArray(v) ? [] : v]))
      : pack.items;
    // sourceDigests are content fingerprints of the memory corpus (F-016); null
    // every string leaf on control so no corpus signal survives.
    const nulledSourceDigests = pack.sourceDigests && typeof pack.sourceDigests === 'object'
      ? Object.fromEntries(Object.entries(pack.sourceDigests).map(([k, v]) => [k, typeof v === 'string' ? null : v]))
      : pack.sourceDigests;
    return {
      ...pack,
      ...(pack.results !== undefined ? { results: emptyResults } : {}),
      ...(pack.items !== undefined ? { items: emptyItems } : {}),
      ...(pack.sourceDigests !== undefined ? { sourceDigests: nulledSourceDigests } : {}),
      // packDigest is a fingerprint of the surfaced set; collapse to the
      // content-free empty-set digest (arm-independent, leaks nothing).
      ...(typeof pack.packDigest === 'string' ? { packDigest: EMPTY_PACK_DIGEST } : {}),
    };
  } catch {
    // Fail CLOSED on control: return a fresh, structurally-empty pack WITHOUT
    // touching the (possibly throwing) input — never the populated original.
    return {
      results: {},
      items: {},
      sourceDigests: {},
      packDigest: EMPTY_PACK_DIGEST,
    } as unknown as T;
  }
}
