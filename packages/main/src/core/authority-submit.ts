import { AuthorityClient, type AuthorityClientOutcome } from './authority-client.js';
import {
  buildTargetBoundEvidenceEnvelope,
  isAuthorityBatchFullyAccepted,
  type AuthorityEvidenceBatchSubmissionResult,
  type AuthorityEvidenceSubmissionResult,
  type EvidenceEnvelopeContract,
} from './authority-contracts.js';
import { classifyAuthorityEvidence, type AuthorityClassification } from './authority-boundary.js';
import {
  authorityModeEnabled,
  loadAuthoritySettings,
  type AuthorityMode,
  type AuthoritySettings,
} from './authority-mode.js';

/**
 * Authority submission glue for verification_evidence_add / batch_add (B-94a6,
 * A-prepost). This module is the seam between the (synchronous, already-preflighted)
 * checklist handler and the async authority HTTP client.
 *
 * Ordering invariant (decision.json chosen=A-prepost; the frozen CHK-002 context's
 * "write local first then POST" sentence is SUPERSEDED and intentionally NOT
 * implemented): the handler runs the FULL local preflight first, then — only if it
 * passed — calls into here to POST, and only writes local evidence after a POST
 * outcome that the active mode accepts. So:
 *   - local preflight failure  -> handler throws before reaching here -> 0 POST + 0 write
 *   - enforce POST failure      -> {proceed:false} -> handler throws -> 0 local write
 *   - shadow failure            -> {proceed:true, warning} -> local write happens
 *   - off                       -> never reaches here (handler short-circuits) -> 0 network
 */

/** Minimal evidence material the handler hands over once preflight passed. */
export interface AuthorityEvidenceMaterial {
  storyId: string;
  itemId: string;
  intentRef: string;
  /** Canonical (already alias-normalized) evidence kind. */
  kind: string;
  command?: string;
  note: string;
  headHash?: string;
  materialHash?: string;
}

/**
 * Result of attempting an authority interaction for a single command invocation.
 * `proceed` tells the handler whether it may write local evidence.
 */
export interface AuthoritySubmitDecision {
  /** Whether the local evidence write may proceed. */
  proceed: boolean;
  /** Single stderr warning line to emit (shadow degradation), if any. */
  warning?: string;
  /** Error to throw instead of writing locally (enforce gating), if any. */
  error?: Error;
}

/**
 * Injectable authority interaction so the handler smoke can count POSTs and force
 * outcomes without a real network. The production implementation is
 * {@link createAuthoritySubmitter}; off mode never constructs one.
 */
export interface AuthoritySubmitter {
  submitSingle(material: AuthorityEvidenceMaterial): Promise<AuthoritySubmitDecision>;
  submitBatch(materials: AuthorityEvidenceMaterial[]): Promise<AuthoritySubmitDecision>;
}

function buildEnvelope(material: AuthorityEvidenceMaterial): EvidenceEnvelopeContract {
  // Use buildTargetBoundEvidenceEnvelope directly (not EvidenceCollector) because the
  // submission needs itemId / intentRef / kind on the envelope; the collector is for
  // VCP-bound evidence which does not surface those handler-level fields.
  return buildTargetBoundEvidenceEnvelope({
    evidenceId: `${material.storyId}:${material.itemId}:${material.intentRef}`,
    projectId: material.storyId,
    storyId: material.storyId,
    producerActorId: process.env.KOALA_AGENT || 'main',
    itemId: material.itemId,
    intentRef: material.intentRef,
    kind: material.kind,
    ...(material.command ? { command: material.command } : {}),
    note: material.note,
    repo: {
      ...(material.headHash ? { headHash: material.headHash } : {}),
      ...(material.materialHash ? { materialHash: material.materialHash } : {}),
    },
    nonce: `${material.storyId}:${material.itemId}:${material.intentRef}:${material.kind}`,
    createdAt: new Date().toISOString(),
  });
}

function describeOutcome(outcome: AuthorityClientOutcome<unknown>): string {
  const status = outcome.status !== undefined ? ` status=${outcome.status}` : '';
  return `${outcome.kind}${status}${outcome.message ? `: ${outcome.message}` : ''}`;
}

/**
 * Map an authority outcome to a per-mode decision.
 *
 * - shadow : ANY outcome (success or failure) -> proceed=true; failures attach a
 *            single stderr warning. Local write is never blocked (Blocker 3).
 * - enforce: success -> proceed=true; any failure -> proceed=false + error
 *            (pre-POST gating, zero local write, Blocker 4).
 *
 * Trust-boundary note (B-ec09 / authority-client-role.md §L2+ Evidence Boundary):
 * an `accepted=true` outcome here is **transport acceptance** of the POST by the
 * Python authority server. It is NOT verification of a signed AuthorityReceipt
 * and does NOT promote a CLI submission to receipt-backed L2+ authority. The
 * CLI envelope is a strict subset (no run bindings / provider / model / vendor /
 * actor signature), so `classifyAuthorityEvidence` will return one of the
 * `thin-client-*` / `local-only` classes for every CLI submission today.
 */
export function classifyCliAuthoritySubmission(
  mode: AuthorityMode,
  envelope: EvidenceEnvelopeContract,
  transportAccepted: boolean,
): AuthorityClassification {
  // CLI never verifies the AuthorityReceipt signature today (advisory A1 /
  // matrix #2 in the cross-end audit). Hardcoded false until a dedicated
  // receipt-verification story lands.
  return classifyAuthorityEvidence({
    mode,
    envelope,
    receiptVerified: false,
    transportAccepted,
  });
}


function decideFromSingle(
  mode: AuthorityMode,
  outcome: AuthorityClientOutcome<AuthorityEvidenceSubmissionResult>,
): AuthoritySubmitDecision {
  const accepted = outcome.ok && outcome.data?.accepted === true;
  if (mode === 'shadow') {
    if (accepted) return { proceed: true };
    const reason = outcome.ok
      ? `authority rejected evidence${outcome.data?.reason ? `: ${outcome.data.reason}` : ''}`
      : describeOutcome(outcome);
    return { proceed: true, warning: `[warning] authority POST failed (shadow, local write kept): ${reason}` };
  }
  // enforce
  if (accepted) return { proceed: true };
  const reason = outcome.ok
    ? `authority rejected evidence${outcome.data?.reason ? `: ${outcome.data.reason}` : ''}`
    : describeOutcome(outcome);
  return {
    proceed: false,
    error: new Error(
      `authority POST failed (enforce, no local write): ${reason}`,
    ),
  };
}

function decideFromBatch(
  mode: AuthorityMode,
  outcome: AuthorityClientOutcome<AuthorityEvidenceBatchSubmissionResult>,
): AuthoritySubmitDecision {
  const fullyAccepted = outcome.ok && outcome.data !== undefined && isAuthorityBatchFullyAccepted(outcome.data);
  if (mode === 'shadow') {
    if (fullyAccepted) return { proceed: true };
    const reason = outcome.ok
      ? batchRejectionReason(outcome.data)
      : describeOutcome(outcome);
    return { proceed: true, warning: `[warning] authority batch POST failed (shadow, local writes kept): ${reason}` };
  }
  // enforce — all-or-nothing: any per-entry rejection maps to whole-batch failure.
  if (fullyAccepted) return { proceed: true };
  const reason = outcome.ok ? batchRejectionReason(outcome.data) : describeOutcome(outcome);
  return {
    proceed: false,
    error: new Error(
      `authority batch POST failed (enforce, no local writes): ${reason}`,
    ),
  };
}

function batchRejectionReason(data: AuthorityEvidenceBatchSubmissionResult | undefined): string {
  if (!data) return 'authority returned no batch result';
  const rejected = (data.results ?? []).filter(r => !r.accepted);
  if (rejected.length > 0) {
    const ids = rejected.map(r => r.evidenceId || r.reason || '?').join(', ');
    return `authority rejected ${rejected.length} entry(ies): ${ids}`;
  }
  return data.reason ? `authority rejected batch: ${data.reason}` : 'authority rejected batch';
}

/**
 * Production submitter backed by a real {@link AuthorityClient}. Only constructed
 * for shadow / enforce with a configured baseURL. Throws (caught by enforce path /
 * surfaced by shadow warning) if the URL is missing while a non-off mode is active.
 */
export function createAuthoritySubmitter(
  settings: AuthoritySettings,
  client?: AuthorityClient,
): AuthoritySubmitter {
  const mode = settings.mode;
  // Runtime re-validation (CLAUDE.md Handler coding convention): never trust that the caller
  // already filtered off; an off mode must never reach a real POST.
  if (!authorityModeEnabled(mode)) {
    throw new Error(`createAuthoritySubmitter called with non-enabled mode '${mode}'`);
  }

  function resolveClient(): { client?: AuthorityClient; missingURLError?: Error } {
    if (client) return { client };
    if (!settings.baseURL) {
      return {
        missingURLError: new Error(
          `LATTICE_AUTHORITY_URL is required when LATTICE_AUTHORITY_MODE='${mode}'`,
        ),
      };
    }
    return { client: new AuthorityClient(settings.baseURL, undefined, settings.timeoutMS) };
  }

  function handleMissingURL(err: Error): AuthoritySubmitDecision {
    if (mode === 'shadow') {
      return { proceed: true, warning: `[warning] authority POST skipped (shadow): ${err.message}` };
    }
    return { proceed: false, error: err };
  }

  /**
   * Catch-all shadow degradation (Blocker 3 / preMortem #2). The AuthorityClient
   * already classifies transport / HTTP failures into an outcome, but a NON-outcome
   * throw can still escape: a bug in buildEnvelope, a fake client whose method throws,
   * a synchronous fetch impl error, a JSON/serialization error, etc. In shadow mode
   * NONE of these may crash the command or block the local write — they degrade to a
   * single stderr [warning] with proceed=true. In enforce mode the throw is converted
   * into a gating error (proceed=false) so it still blocks the local write, but as a
   * controlled decision rather than an uncaught exception bubbling out of the handler.
   */
  function degradeThrow(err: unknown): AuthoritySubmitDecision {
    const reason = err instanceof Error ? err.message : String(err);
    if (mode === 'shadow') {
      return { proceed: true, warning: `[warning] authority POST failed (shadow, local write kept): ${reason}` };
    }
    return {
      proceed: false,
      error: err instanceof Error ? err : new Error(`authority POST failed (enforce, no local write): ${reason}`),
    };
  }

  return {
    async submitSingle(material) {
      try {
        const { client: c, missingURLError } = resolveClient();
        if (!c) return handleMissingURL(missingURLError!);
        const outcome = await c.submitEvidence(buildEnvelope(material));
        return decideFromSingle(mode, outcome);
      } catch (err) {
        return degradeThrow(err);
      }
    },
    async submitBatch(materials) {
      try {
        const { client: c, missingURLError } = resolveClient();
        if (!c) return handleMissingURL(missingURLError!);
        const outcome = await c.submitEvidenceBatch(materials.map(buildEnvelope));
        return decideFromBatch(mode, outcome);
      } catch (err) {
        return degradeThrow(err);
      }
    },
  };
}

/**
 * Resolve the active authority settings for a handler invocation. Centralized so
 * the env -> normalize path is identical for single + batch (and so the handler
 * smoke can inject settings without env mutation).
 */
export function resolveAuthoritySettings(override?: AuthoritySettings): AuthoritySettings {
  return override ?? loadAuthoritySettings();
}
