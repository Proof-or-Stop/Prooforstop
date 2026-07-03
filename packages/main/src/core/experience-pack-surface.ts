/**
 * B-ab8d CHK-002: Single shared surfacing leaf for the experiment-arm-gated
 * FULL runtime memory pack (MemoryFreshnessPack) render.
 *
 * This extends the proven experience-hint-surface pattern (B-5a48) from the
 * advisory review hints to the full runtime pack: ONE place owns the
 * arm resolution + event dedup + render-gate, so the seven lifecycle
 * entrypoints (story-create, transition-orchestrator, session, lattice-handoff,
 * done-prepare, done-closure, dev-memory) share an identical implementation
 * with NO drift in the dedup key, the event payload, or the render-gate.
 *
 * Behavior:
 *  - `buildPack()` (caller-supplied) ALWAYS computes the pack, on BOTH arms and
 *    with no experiment active. A build throw PROPAGATES to the caller so each
 *    site's existing try/catch fallback stays byte-identical to today.
 *  - NO experiment context (`resolveExperimentArm()` returns null): behavior is
 *    byte-identical to production today — `shouldRender=true`, NO new event,
 *    no activity-log read. This leaf is a pass-through in that case.
 *  - Experiment active (control OR treatment): exactly one
 *    `experience_pack_surfaced` event per dedup key
 *    `(experimentId, consumer, storyId-or-'global', roundKey)` is appended via
 *    `appendActivityLog`, carrying `{experimentId, arm, consumer, storyId,
 *    roundKey, packDigest, topHitIds}` — the event fires on BOTH arms so
 *    measurement is lossless. Dedup scans `readActivityLogTail(root, 1000)`,
 *    mirroring experience-hint-surface.ts.
 *  - RENDER-GATE: `shouldRender` is `true` on treatment (and with no
 *    experiment), `false` on control. Only the RENDER is gated; the pack is
 *    still computed and the event still fires on control.
 *
 * ADVISORY-ONLY / NON-AUTHORITATIVE: the arm value must NEVER reach
 * resolveReviewPromptHash, issues/blocker computation, or any gate decision.
 * This leaf only informs whether the advisory pack SECTION is rendered.
 * An event append failure is swallowed (console.warn) and never breaks the
 * calling handler; `authority=non_authoritative` / `gateEvidence=false` pack
 * semantics are untouched (buildMemoryFreshnessPack internals unchanged).
 *
 * ISOLATION BAR: imports ONLY the existing core leaves experiment-arm /
 * activity-log / playbook-runtime-memory. Zero new cross-layer edges; no
 * import from gate or hash modules.
 */

import { appendActivityLog, readActivityLogTail } from './activity-log.js';
import { resolveExperimentArm, EXPERIMENT_ARM_VALUES } from './experiment-arm.js';
import type { ExperimentArmContext } from './experiment-arm.js';
import { runtimeMemoryTopHits } from './playbook-runtime-memory.js';
import type { MemoryFreshnessPack, RuntimeConsumer } from './playbook-runtime-memory.js';

/** Canonical activity-log event name for full-pack surfacing. */
export const EXPERIENCE_PACK_SURFACED_EVENT = 'experience_pack_surfaced';

export interface SurfaceRuntimeMemoryPackOptions {
  /** Which lifecycle entrypoint is surfacing the pack (dedup key part). */
  consumer: RuntimeConsumer;
  /** Story scope for the dedup key; omitted/blank normalizes to 'global'. */
  storyId?: string;
  /**
   * Stable per-round dedup key part supplied by the CALLER (phase, transition,
   * etc.); omitted/blank normalizes to 'default'. The leaf never computes a
   * round formula — call sites own their round namespaces.
   */
  roundKey?: string;
  /**
   * Computes the pack (typically a buildMemoryFreshnessPack call). ALWAYS
   * invoked — on both arms and with no experiment. Throws propagate to the
   * caller so existing per-site catch fallbacks keep today's behavior.
   */
  buildPack: () => MemoryFreshnessPack;
}

export interface SurfaceRuntimeMemoryPackResult {
  /** The computed pack (always available; embed/JSON use is NOT arm-gated). */
  pack: MemoryFreshnessPack;
  /** The active experiment context, or null when no experiment is active. */
  experiment: ExperimentArmContext | null;
  /** True on treatment or with no experiment; false ONLY on control. */
  shouldRender: boolean;
  /** True only when this call appended a new experience_pack_surfaced event. */
  fired: boolean;
}

/**
 * Runtime re-validation of the resolved experiment context (handler coding
 * convention: consumers re-check constraints instead of trusting upstream).
 * Any malformed context degrades to null = no experiment active.
 */
function validExperimentContext(): ExperimentArmContext | null {
  const experiment = resolveExperimentArm();
  if (experiment === null) return null;
  if (typeof experiment.experimentId !== 'string' || experiment.experimentId.trim().length === 0) return null;
  if (!(EXPERIMENT_ARM_VALUES as readonly string[]).includes(experiment.arm)) return null;
  return experiment;
}

/**
 * Pure render-gate probe for sites that render an ALREADY-computed pack (e.g.
 * a pack loaded from a handoff file) and therefore do not go through
 * surfaceRuntimeMemoryPack at render time. False ONLY on the control arm.
 */
export function shouldRenderRuntimeMemoryPack(): boolean {
  const experiment = validExperimentContext();
  return experiment === null || experiment.arm === 'treatment';
}

/**
 * Compute the pack, fire the once-per-key experience_pack_surfaced event when
 * an experiment is active, and decide the render-gate. See the module comment
 * for the full semantics.
 */
export function surfaceRuntimeMemoryPack(
  root: string,
  opts: SurfaceRuntimeMemoryPackOptions,
): SurfaceRuntimeMemoryPackResult {
  const pack = opts.buildPack();
  const experiment = validExperimentContext();
  if (experiment === null) {
    // No experiment: byte-identical pass-through — no event, no log read.
    return { pack, experiment: null, shouldRender: true, fired: false };
  }
  const storyKey = opts.storyId && opts.storyId.trim().length > 0 ? opts.storyId.trim() : 'global';
  const roundKey = opts.roundKey && opts.roundKey.trim().length > 0 ? opts.roundKey.trim() : 'default';
  let fired = false;
  try {
    // Dedup: one event per (experimentId, consumer, storyId-or-global, roundKey).
    const alreadySurfaced = readActivityLogTail(root, 1000).some(
      (e) => e.event === EXPERIENCE_PACK_SURFACED_EVENT
        && e.experimentId === experiment.experimentId
        && e.consumer === opts.consumer
        && e.storyId === storyKey
        && e.roundKey === roundKey,
    );
    if (!alreadySurfaced) {
      // Fires on BOTH arms; the arm field records which arm surfaced
      // (treatment) or shadow-suppressed (control) the section.
      appendActivityLog(root, {
        timestamp: new Date().toISOString(),
        event: EXPERIENCE_PACK_SURFACED_EVENT,
        experimentId: experiment.experimentId,
        arm: experiment.arm,
        consumer: opts.consumer,
        storyId: storyKey,
        roundKey,
        packDigest: pack.packDigest,
        topHitIds: runtimeMemoryTopHits(pack).ids,
      });
      fired = true;
    }
  } catch (e) {
    // Advisory-only: never let event tracking break the calling handler.
    console.warn(
      `[experience-pack] surface event failed for ${opts.consumer}:`,
      (e as Error).message,
    );
  }
  return { pack, experiment, shouldRender: experiment.arm === 'treatment', fired };
}
