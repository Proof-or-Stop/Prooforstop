import { commandRequiresAuthoritativeRuntime, type OwnershipClass } from '../core/command-policy.js';
import {
  classifyRuntimeEntrypointAuthority,
  renderRuntimeEntrypointAuthorityFailure,
  type RuntimeEntrypointAuthorityDecision,
} from '../core/runtime-environment-checks.js';

export interface StoryRuntimeAdmissionInput {
  command: string;
  commandArgs: string[];
  projectRoot: string;
  effectiveOwnership: OwnershipClass | null;
  invokedEntrypoint?: string | null;
  loadedCorePackageRoot?: string | null;
  env?: Record<string, string | undefined>;
}

/**
 * Single pre-write admission boundary for the command-policy-derived
 * Story writer classes. No command-name allowlist is maintained here.
 */
export function enforceStoryRuntimeAdmission(
  input: StoryRuntimeAdmissionInput,
): RuntimeEntrypointAuthorityDecision | null {
  const requiresAuthoritativeRuntime = commandRequiresAuthoritativeRuntime(input.command, input.effectiveOwnership);
  if (!requiresAuthoritativeRuntime) return null;
  const decision = classifyRuntimeEntrypointAuthority({
    command: input.command,
    commandArgs: input.commandArgs,
    projectRoot: input.projectRoot,
    invokedEntrypoint: input.invokedEntrypoint,
    loadedCorePackageRoot: input.loadedCorePackageRoot,
    env: input.env,
    requiresAuthoritativeRuntime: true,
  });
  if (decision.status === 'blocked') {
    throw new Error(renderRuntimeEntrypointAuthorityFailure(decision));
  }
  return decision;
}
