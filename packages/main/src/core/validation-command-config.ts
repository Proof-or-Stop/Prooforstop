/** Shared config normalization for validation execution and scope accounting. */
import type { ValidationCommand } from './validation-types.js';
import { validateResourceClaims, type ResourceClaim } from './keyed-scheduler.js';
import { assertDeclaredValidationCommandId, parseLegacyValidationCommandString } from './validation-command-identity.js';

export function commandFromString(label: string, value: string): ValidationCommand | null {
  const parsed = parseLegacyValidationCommandString(value);
  if (!parsed) return null;
  return parsed.shell
    ? { label, command: parsed.command, args: [], shell: true }
    : { label, command: parsed.command, args: parsed.args };
}

/**
 * Parse `validate.commands[].resources` from config into resource claims.
 *
 * Malformed or unrecognised claims THROW here, at declaration time, so a typo'd
 * class fails the whole validate run loudly instead of being dropped and
 * quietly turning into a command with no declared claim. (The fail-closed
 * default in resolveValidationCommandResources would still schedule such a
 * command alone, but a silently ignored declaration is a lie the operator
 * cannot see.)
 */
function parseConfiguredResourceClaims(value: unknown, owner: string): ResourceClaim[] {
  if (!Array.isArray(value)) {
    throw new Error(`${owner}: resources must be an array of resource claims`);
  }
  const claims = value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${owner}: every resource claim must be an object with class, key and access`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.class !== 'string' || typeof entry.key !== 'string' || typeof entry.access !== 'string') {
      throw new Error(`${owner}: every resource claim must be an object with class, key and access`);
    }
    return {
      class: entry.class as ResourceClaim['class'],
      key: entry.key,
      access: entry.access as ResourceClaim['access'],
      ...(entry.ownership !== undefined ? { ownership: entry.ownership as ResourceClaim['ownership'] } : {}),
    };
  });
  validateResourceClaims(claims, owner);
  return claims;
}

function normalizeValidateFocus(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const focus = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
  return focus.length > 0 ? focus : undefined;
}

export function filterFocusedConfiguredCommands(commands: ValidationCommand[], focus: string): ValidationCommand[] {
  const selected = commands.filter((cmd) => cmd.focus?.includes(focus));
  if (selected.length === 0) {
    throw new Error(
      `validate --focus=${focus}: no configured validate.commands are tagged with focus "${focus}"; ` +
      `tag one or more commands with focus: ["${focus}"] or run proof-or-stop validate --json for full validation.`,
    );
  }
  return selected;
}

export function configuredValidationCommandEntries(config: unknown): { commands: ValidationCommand[]; legacyLabels: string[] } {
  const cfg = config as any;
  const validate = cfg.validate || cfg.validation;
  const commands: ValidationCommand[] = [];
  const legacyLabels: string[] = [];
  if (!validate || typeof validate !== 'object') return { commands, legacyLabels };
  const dynamicDefaults = validate.dynamic?.policyDefaults && typeof validate.dynamic.policyDefaults === 'object'
    ? validate.dynamic.policyDefaults : {};
  const applyDynamicDefaults = (command: ValidationCommand): ValidationCommand => ({
    ...command,
    ...(command.assurance !== undefined ? {} : typeof dynamicDefaults.assurance === 'string' ? { assurance: dynamicDefaults.assurance } : {}),
    ...(command.riskTier !== undefined ? {} : typeof dynamicDefaults.riskTier === 'string' ? { riskTier: dynamicDefaults.riskTier } : {}),
    ...(command.closurePolicy !== undefined ? {} : typeof dynamicDefaults.closurePolicy === 'string' ? { closurePolicy: dynamicDefaults.closurePolicy } : {}),
    ...(command.fullBaselineReusePolicy !== undefined ? {} : typeof dynamicDefaults.fullBaselineReusePolicy === 'string' ? { fullBaselineReusePolicy: dynamicDefaults.fullBaselineReusePolicy } : {}),
    ...(command.cpuWeight !== undefined ? {} : typeof dynamicDefaults.cpuWeight === 'number' ? { cpuWeight: dynamicDefaults.cpuWeight } : {}),
    ...(command.expectedP50Ms !== undefined ? {} : typeof dynamicDefaults.expectedP50Ms === 'number' ? { expectedP50Ms: dynamicDefaults.expectedP50Ms } : {}),
  });

  if (typeof validate.command === 'string') {
    const cmd = commandFromString('configured validate.command', validate.command);
    if (cmd) { commands.push(applyDynamicDefaults(cmd)); legacyLabels.push(validate.command); }
  }
  if (Array.isArray(validate.commands)) {
    for (let i = 0; i < validate.commands.length; i++) {
      const entry = validate.commands[i];
      if (typeof entry === 'string') {
        const cmd = commandFromString(`configured validate.commands[${i}]`, entry);
        if (cmd) { commands.push(applyDynamicDefaults(cmd)); legacyLabels.push(entry); }
      } else if (entry && typeof entry === 'object' && typeof entry.command === 'string') {
        const configuredInputRoots = Array.isArray(entry.inputRoots)
          ? entry.inputRoots.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
          : undefined;
        if (entry.inputsComplete === true && (!configuredInputRoots || configuredInputRoots.length === 0)) {
          throw new Error(`configured validate.commands[${i}]: inputsComplete requires at least one non-empty string inputRoots entry`);
        }
        const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
        const focus = normalizeValidateFocus(entry.focus);
        legacyLabels.push(entry.label ?? entry.command);
        commands.push({
          label: typeof entry.label === 'string' ? entry.label : `configured validate.commands[${i}]`,
          command: entry.command,
          args,
          ...(entry.shell === true ? { shell: true } : {}),
          ...(entry.executionReuse === 'exact-inputs' ? {executionReuse:'exact-inputs' as const} : {}),
          ...(Array.isArray(entry.executionInputs) ? {executionInputs:entry.executionInputs} : {}),
          ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
          ...(entry.env && typeof entry.env === 'object' ? { env: Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)])) } : {}),
          ...(Array.isArray(entry.declaredEnvironmentKeys) ? { declaredEnvironmentKeys: entry.declaredEnvironmentKeys.filter((item: unknown): item is string => typeof item === 'string') } : {}),
          ...(typeof entry.caseRegistryPath === 'string' ? { caseRegistryPath: entry.caseRegistryPath } : {}),
          ...(typeof entry.runnerSourcePath === 'string' ? { runnerSourcePath: entry.runnerSourcePath } : {}),
          ...(configuredInputRoots ? { inputRoots: configuredInputRoots } : {}),
          ...(typeof entry.inputsComplete === 'boolean' ? { inputsComplete: entry.inputsComplete } : {}),
          ...(typeof entry.assurance === 'string' ? { assurance: entry.assurance } : typeof dynamicDefaults.assurance === 'string' ? { assurance: dynamicDefaults.assurance } : {}),
          ...(typeof entry.riskTier === 'string' ? { riskTier: entry.riskTier } : typeof dynamicDefaults.riskTier === 'string' ? { riskTier: dynamicDefaults.riskTier } : {}),
          ...(typeof entry.closurePolicy === 'string' ? { closurePolicy: entry.closurePolicy } : typeof dynamicDefaults.closurePolicy === 'string' ? { closurePolicy: dynamicDefaults.closurePolicy } : {}),
          ...(typeof entry.fullBaselineReusePolicy === 'string' ? { fullBaselineReusePolicy: entry.fullBaselineReusePolicy } : typeof dynamicDefaults.fullBaselineReusePolicy === 'string' ? { fullBaselineReusePolicy: dynamicDefaults.fullBaselineReusePolicy } : {}),
          ...(typeof entry.cpuWeight === 'number' ? { cpuWeight: entry.cpuWeight } : typeof dynamicDefaults.cpuWeight === 'number' ? { cpuWeight: dynamicDefaults.cpuWeight } : {}),
          ...(typeof entry.expectedP50Ms === 'number' ? { expectedP50Ms: entry.expectedP50Ms } : typeof dynamicDefaults.expectedP50Ms === 'number' ? { expectedP50Ms: dynamicDefaults.expectedP50Ms } : {}),
          ...(typeof entry.timeoutMs === 'number' ? { timeoutMs: entry.timeoutMs } : {}),
          ...(typeof entry.optional === 'boolean' ? { optional: entry.optional } : {}),
          ...(focus ? { focus } : {}),
          ...(entry.resources !== undefined
            ? { resources: parseConfiguredResourceClaims(entry.resources, `configured validate.commands[${i}]`) }
            : {}),
          // B-a745 CHK-001: an optional declared planner id. Malformed or
          // reserved-namespace values THROW here, at declaration time, for the
          // same reason parseConfiguredResourceClaims does: a silently dropped
          // declaration is a lie the operator cannot see, and a forged `prov-`
          // id would also corrupt the provisional-migration count.
          ...(entry.id !== undefined
            ? { id: assertDeclaredValidationCommandId(entry.id, `configured validate.commands[${i}]`) }
            : {}),
        });
      }
    }
  }
  return { commands, legacyLabels };
}


export function normalizeConfiguredValidationCommands(config: unknown): ValidationCommand[] {
  return configuredValidationCommandEntries(config).commands;
}
