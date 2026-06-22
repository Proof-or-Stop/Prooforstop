/**
 * authority_enforce_policy handler — B-ea92 Milestone 1
 *
 * Read-only authority policy discovery. Queries GET /v1/authority/policy and
 * prints the discovered policy fields. NEVER submits evidence, claims jobs,
 * registers actor keys, executes providers, signs envelopes, or verifies
 * receipts.
 *
 * Every successful output always includes the discovery-only disclaimer:
 *   "Authority policy discovery only: no receipt, no gate pass, no evidence submission."
 */

import { existsSync, readFileSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import {
  AuthorityClient,
  loadAuthorityConfig,
  type AuthorityConfigLoadOptions,
  type AuthorityFetch,
} from '../core/authority-client.js';
import {
  upsertAuthorityGateReceiptRef,
  type AuthorityGateDecisionReceiptRef,
} from '../core/authority-gate-receipts.js';
import {
  AuthorityGateReceiptProofSchema,
  normalizeAuthorityGatePhase,
  verifyAuthorityGateReceiptProof,
  type AuthorityGatePhase,
  type AuthorityGateReceiptProof,
} from '../core/authority-gate-receipt-verifier.js';
import { loadAuthoritySettings } from '../core/authority-mode.js';

/** Disclaimer line printed on every successful discovery output. */
export const AUTHORITY_ENFORCE_POLICY_DISCLAIMER =
  'Authority policy discovery only: no receipt, no gate pass, no evidence submission.';

export interface AuthorityEnforcePolicyArgs {
  authorityURL?: string;
  authorityTimeoutMS?: number;
  /** Injected fetch for tests — not exposed in CLI schema. */
  _fetchImpl?: AuthorityFetch;
}

export interface AuthorityEnforcePolicyResult {
  ok: boolean;
  disclaimer: string;
  contractVersion?: string;
  purpose?: string;
  requiredAuthorityMode?: string;
  commandCatalogDigest?: string;
  evidenceSchemaDigest?: string;
  supportedAuthorityModes?: string[];
  evidencePolicyPreset?: string;
  compatibility?: Record<string, unknown>;
  error?: string;
}

export interface AuthorityReceiptVerifyArgs {
  storyId?: string;
  phase?: AuthorityGatePhase | string;
  targetPhase?: AuthorityGatePhase | string;
  headHash?: string;
  materialHash?: string;
  authorityURL?: string;
  proof?: unknown;
  proofFile?: string;
  proofPath?: string;
  productionAuthorityKeyDigests?: string[] | string;
  localTestAuthorityKeyDigests?: string[] | string;
  dryRun?: boolean;
  now?: string;
  format?: 'text' | 'json';
  json?: boolean;
  _fetchImpl?: AuthorityFetch;
}

export interface AuthorityReceiptVerifyResult {
  schemaVersion: 'lattice.authority_receipt_verify.v1';
  ok: boolean;
  written: boolean;
  path?: string;
  receiptId?: string;
  decisionId?: string;
  classification: string;
  receiptVerified: boolean;
  productionReady: boolean;
  failureReason?: string;
  ref?: AuthorityGateDecisionReceiptRef;
}

/**
 * Core implementation — pure function so it is testable without a real
 * HandlerContext. Takes an explicit fetch and authority URL for smoke coverage.
 */
export async function runAuthorityEnforcePolicy(
  args: AuthorityEnforcePolicyArgs,
  env: Record<string, string | undefined> = process.env,
  options: AuthorityConfigLoadOptions = {},
): Promise<AuthorityEnforcePolicyResult> {
  const settings = loadAuthorityConfig(env, {
    authorityURL: args.authorityURL,
    authorityTimeoutMS: args.authorityTimeoutMS,
  }, options);

  if (!settings.baseURL) {
    return {
      ok: false,
      disclaimer: AUTHORITY_ENFORCE_POLICY_DISCLAIMER,
      error: 'LATTICE_AUTHORITY_URL is not set; authority policy discovery requires an authority server URL.',
    };
  }

  const client = new AuthorityClient(
    settings.baseURL,
    args._fetchImpl,
    settings.timeoutMS,
  );

  const outcome = await client.discoverPolicy();

  if (!outcome.ok) {
    return {
      ok: false,
      disclaimer: AUTHORITY_ENFORCE_POLICY_DISCLAIMER,
      error: `policy discovery failed (${outcome.kind}): ${outcome.message ?? 'unknown error'}`,
    };
  }

  const policy = outcome.data!;
  return {
    ok: true,
    disclaimer: AUTHORITY_ENFORCE_POLICY_DISCLAIMER,
    contractVersion: policy.contractVersion,
    purpose: policy.purpose,
    // requiredAuthorityMode is a top-level field in the real Python contract
    // (maps to policy.required_authority_mode on the server).
    requiredAuthorityMode: policy.requiredAuthorityMode,
    commandCatalogDigest: policy.commandCatalogDigest,
    evidenceSchemaDigest: policy.evidenceSchemaDigest,
    supportedAuthorityModes: policy.supportedAuthorityModes,
    evidencePolicyPreset: policy.evidencePolicy?.preset,
    compatibility: policy.compatibility,
  };
}

function wantsJson(args: { format?: string; json?: boolean }): boolean {
  return args.format === 'json' || args.json === true;
}

function asArray(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function asSha256Digest(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] | undefined {
  const field = value[key];
  return Array.isArray(field) && field.every((item) => typeof item === 'string')
    ? field
    : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function parseProofText(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

async function loadProof(args: AuthorityReceiptVerifyArgs): Promise<unknown> {
  if (args.proof !== undefined) {
    if (typeof args.proof === 'string') return parseProofText(args.proof, 'proof');
    return args.proof;
  }
  if (args.proofFile) {
    return parseProofText(readFileSync(args.proofFile, 'utf8'), args.proofFile);
  }
  if (args.proofPath) {
    const settings = loadAuthoritySettings(process.env, {
      authorityURL: args.authorityURL,
      authorityTimeoutMS: undefined,
    });
    if (!settings.baseURL) {
      throw new Error('LATTICE_AUTHORITY_URL is not set; proofPath fetch requires an authority server URL.');
    }
    const client = new AuthorityClient(settings.baseURL, args._fetchImpl, settings.timeoutMS);
    const outcome = await client.fetchGateReceiptProof(args.proofPath);
    if (!outcome.ok) {
      throw new Error(`authority receipt proof fetch failed (${outcome.kind}): ${outcome.message ?? 'unknown error'}`);
    }
    return outcome.data;
  }
  throw new Error('authority_receipt_verify requires proof, proofFile, or proofPath.');
}

function buildReceiptRef(
  proof: AuthorityGateReceiptProof,
  result: ReturnType<typeof verifyAuthorityGateReceiptProof>,
  args: AuthorityReceiptVerifyArgs,
  verifiedAt: string,
): AuthorityGateDecisionReceiptRef {
  const decision = proof.decisionPayload as Record<string, unknown>;
  const input = proof.inputPayload;
  const targetPhase = result.targetPhase
    ?? normalizeAuthorityGatePhase(args.phase ?? args.targetPhase ?? input.targetPhase)
    ?? input.targetPhase;
  return {
    receiptId: result.receiptId!,
    receiptKind: 'gate_decision',
    classification: 'production-gate-decision',
    authorityUrl: args.authorityURL,
    authorityKeyId: result.authorityKeyId,
    authorityPublicKeyDigest: result.authorityPublicKeyDigest,
    decisionId: result.decisionId,
    stateVersion: result.stateVersion ?? numberField(decision, 'stateVersion'),
    gateInputDigest: asSha256Digest(result.inputDigest),
    decisionDigest: asSha256Digest(result.decisionDigest),
    decisionVerdict: result.decisionVerdict ?? stringField(decision, 'verdict'),
    storyId: input.storyId,
    targetPhase,
    headHash: input.repo.headHash,
    materialHash: input.repo.materialHash,
    policyMode: stringField(decision, 'policyMode'),
    authorityMode: stringField(decision, 'authorityMode'),
    producerRunIds: stringArrayField(decision, 'producerRunIds'),
    verifierRunIds: stringArrayField(decision, 'verifierRunIds'),
    sessionId: stringField(decision, 'sessionId'),
    runnerSessionIds: stringArrayField(decision, 'runnerSessionIds'),
    evidenceDigests: stringArrayField(decision, 'evidenceDigests'),
    verifiedAt,
    verifiedBy: 'lattice authority receipt verify',
    eligibleGates: stringArrayField(decision, 'eligibleGates') ?? [targetPhase],
    status: 'active',
    consumptionEvents: [],
  };
}

export async function runAuthorityReceiptVerify(
  ctx: HandlerContext,
  args: AuthorityReceiptVerifyArgs,
): Promise<AuthorityReceiptVerifyResult> {
  if (!args.storyId || args.storyId.trim().length === 0) {
    throw new Error('authority_receipt_verify requires storyId so the story owner lease can guard the receipt-ref write.');
  }
  const storyId = args.storyId.trim();
  if (!existsSync(ctx.store.storyFilePath(storyId, 'index.json'))) {
    throw new Error(`authority_receipt_verify requires an existing story index at ${ctx.store.storyDirRel()}/${storyId}/index.json; refusing to create receipt refs for an unknown story.`);
  }
  ctx.store.readStory(storyId);
  const proofValue = await loadProof(args);
  const parsed = AuthorityGateReceiptProofSchema.safeParse(proofValue);
  const proof = parsed.success ? parsed.data : undefined;
  const verification = verifyAuthorityGateReceiptProof(proofValue, {
    expected: proof ? {
      storyId,
      phase: args.phase ?? args.targetPhase ?? proof.inputPayload.targetPhase,
      headHash: args.headHash ?? proof.inputPayload.repo.headHash,
      materialHash: args.materialHash ?? proof.inputPayload.repo.materialHash,
    } : undefined,
    now: args.now,
    trust: {
      productionAuthorityKeyDigests: asArray(args.productionAuthorityKeyDigests),
      localTestAuthorityKeyDigests: asArray(args.localTestAuthorityKeyDigests),
    },
  });
  const base: AuthorityReceiptVerifyResult = {
    schemaVersion: 'lattice.authority_receipt_verify.v1',
    ok: verification.ok,
    written: false,
    receiptId: verification.receiptId,
    decisionId: verification.decisionId,
    classification: verification.classification,
    receiptVerified: verification.receiptVerified,
    productionReady: verification.productionReady,
    failureReason: verification.failureReason,
  };
  if (!proof || !verification.productionReady) return base;

  const ref = buildReceiptRef(proof, verification, args, args.now ?? new Date().toISOString());
  if (!args.dryRun) {
    const document = upsertAuthorityGateReceiptRef(
      ctx.store.readAuthorityReceiptRefs(storyId) ?? undefined,
      ref,
      ref.verifiedAt!,
    );
    ctx.store.writeAuthorityReceiptRefs(storyId, document);
  }
  return {
    ...base,
    ok: true,
    written: !args.dryRun,
    path: `${ctx.store.storyDirRel()}/${storyId}/authority-receipt-refs.json`,
    ref,
  };
}

function renderAuthorityReceiptVerifyText(result: AuthorityReceiptVerifyResult): string {
  const verdict = result.ok ? 'PASS' : 'BLOCKED';
  const lines = [
    `Receipt verification: ${verdict} receiptVerified=${result.receiptVerified} classification=${result.classification}${result.receiptId ? ` receiptId=${result.receiptId}` : ''}${result.ref?.decisionDigest ? ` decisionDigest=${result.ref.decisionDigest}` : ''}`,
  ];
  if (result.written && result.path && result.receiptId) {
    lines.push(`Receipt ref: PASS path=${result.path} receiptId=${result.receiptId} status=${result.ref?.status ?? 'active'}`);
  } else if (!result.written) {
    lines.push(`Receipt ref: SKIP reason=${result.failureReason ?? 'not_production_gate_decision'}`);
  }
  return lines.join('\n');
}

export function createAuthorityEnforceHandlers(_ctx: HandlerContext) {
  return {
    authority_enforce_policy: async (args: AuthorityEnforcePolicyArgs) => {
      const result = await runAuthorityEnforcePolicy(args, process.env, { cwd: _ctx.root });

      if (!result.ok) {
        // Throw so runCli exits non-zero; include the disclaimer in the message.
        throw new Error([
          `❌ ${result.error}`,
          result.disclaimer,
        ].join('\n'));
      }

      const lines: string[] = [
        result.disclaimer,
        '',
        `contractVersion:        ${result.contractVersion}`,
        `purpose:                ${result.purpose}`,
        `requiredAuthorityMode:  ${result.requiredAuthorityMode}`,
        `commandCatalogDigest:   ${result.commandCatalogDigest}`,
        `evidenceSchemaDigest:   ${result.evidenceSchemaDigest}`,
        `supportedModes:         ${(result.supportedAuthorityModes ?? []).join(', ')}`,
        `evidencePolicy.preset:  ${result.evidencePolicyPreset}`,
      ];
      return lines.join('\n');
    },
    authority_receipt_verify: async (args: AuthorityReceiptVerifyArgs) => {
      const result = await runAuthorityReceiptVerify(_ctx, args);
      return wantsJson(args) ? result : renderAuthorityReceiptVerifyText(result);
    },
  };
}
