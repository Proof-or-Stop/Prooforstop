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

import type { HandlerContext } from './context.js';
import { AuthorityClient, type AuthorityFetch } from '../core/authority-client.js';
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

/**
 * Core implementation — pure function so it is testable without a real
 * HandlerContext. Takes an explicit fetch and authority URL for smoke coverage.
 */
export async function runAuthorityEnforcePolicy(
  args: AuthorityEnforcePolicyArgs,
  env: Record<string, string | undefined> = process.env,
): Promise<AuthorityEnforcePolicyResult> {
  const settings = loadAuthoritySettings(env, {
    authorityURL: args.authorityURL,
    authorityTimeoutMS: args.authorityTimeoutMS,
  });

  if (!settings.baseURL) {
    return {
      ok: false,
      disclaimer: AUTHORITY_ENFORCE_POLICY_DISCLAIMER,
      error: 'KOALA_AUTHORITY_URL is not set; authority policy discovery requires an authority server URL.',
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

export function createAuthorityEnforceHandlers(_ctx: HandlerContext) {
  return {
    authority_enforce_policy: async (args: AuthorityEnforcePolicyArgs) => {
      const result = await runAuthorityEnforcePolicy(args);

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
  };
}
