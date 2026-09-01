import { isOwnershipClass, type OwnershipClass } from '../core/command-policy.js';
import type { ToolDef } from './main-tools.js';

export interface ExternalCommandAdmission {
  readonly commandNames: ReadonlySet<string>;
  readonly ownershipClasses: Readonly<Record<string, OwnershipClass>>;
  readonly allowedPhases: Readonly<Record<string, readonly string[] | 'all'>>;
}

export type RegisteredHandlerSnapshot = ReadonlyMap<string, unknown>;

function ownKeys(value: Readonly<Record<string, unknown>> | undefined): string[] {
  return Object.keys(value ?? {}).sort();
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * Admit lifecycle-aware commands supplied by a bootstrap extension.
 *
 * MAIN_TOOLS names remain core-owned even when an optional package supplies a
 * handler implementation for one of those catalogued commands. A genuinely
 * external command must have one unique ToolDef plus exact ownership and phase
 * rows. This prevents extension metadata from reclassifying a core command or
 * from turning a missing declaration into a phase-gate bypass.
 */
export function validateExternalCommandDeclarations(input: {
  mainTools: readonly ToolDef[];
  extraTools?: readonly ToolDef[];
  extraOwnershipClasses?: Readonly<Record<string, OwnershipClass>>;
  extraAllowedPhases?: Readonly<Record<string, readonly string[] | 'all'>>;
}): ExternalCommandAdmission {
  const mainNames = new Set(input.mainTools.map(tool => tool.name));
  const extraNames = (input.extraTools ?? []).map(tool => tool.name);
  const duplicateExtraNames = [...new Set(extraNames.filter((name, index) => extraNames.indexOf(name) !== index))].sort();
  if (duplicateExtraNames.length > 0) {
    throw new Error(`External command admission rejected duplicate extraTools: ${duplicateExtraNames.join(', ')}`);
  }

  const toolCollisions = [...new Set(extraNames.filter(name => mainNames.has(name)))].sort();
  if (toolCollisions.length > 0) {
    throw new Error(`External command admission rejected core command collision: ${toolCollisions.join(', ')}`);
  }

  const externalToolNames = new Set(extraNames);
  const ownershipNames = ownKeys(input.extraOwnershipClasses);
  const lifecycleNames = ownKeys(input.extraAllowedPhases);
  const collisions = [...new Set([...ownershipNames, ...lifecycleNames].filter(name => mainNames.has(name)))].sort();
  if (collisions.length > 0) {
    throw new Error(`External command admission rejected core command collision: ${collisions.join(', ')}`);
  }
  const externalNames = [...externalToolNames].sort();
  if (!sameNames(externalNames, ownershipNames) || !sameNames(externalNames, lifecycleNames)) {
    throw new Error(
      `External command admission requires exact extraTools/ownership/phase parity ` +
      `(tools=${externalNames.join(',') || '(none)'}; ownership=${ownershipNames.join(',') || '(none)'}; phases=${lifecycleNames.join(',') || '(none)'})`,
    );
  }
  const missingTools = ownershipNames.filter(name => !externalToolNames.has(name));
  if (missingTools.length > 0) {
    throw new Error(`External command admission rejected declarations without matching extraTools: ${missingTools.join(', ')}`);
  }

  for (const name of ownershipNames) {
    const ownership = input.extraOwnershipClasses?.[name];
    if (!isOwnershipClass(ownership)) {
      throw new Error(`External command admission rejected invalid ownershipClass for ${name}`);
    }
    const phases = input.extraAllowedPhases?.[name];
    if (phases !== 'all' && (!Array.isArray(phases) || phases.length === 0 || phases.some(phase => typeof phase !== 'string' || !phase.trim()))) {
      throw new Error(`External command admission rejected invalid allowedPhases for ${name}`);
    }
  }

  return {
    commandNames: new Set(externalNames),
    ownershipClasses: input.extraOwnershipClasses ?? {},
    allowedPhases: input.extraAllowedPhases ?? {},
  };
}

export function validateExternalCommandHandlers(
  admission: ExternalCommandAdmission,
  coreHandlers: RegisteredHandlerSnapshot,
  registeredHandlers: Readonly<Record<string, unknown>>,
  extraTools: readonly ToolDef[] = [],
): void {
  const registeredNames = Object.keys(registeredHandlers).sort();
  const registeredNameSet = new Set(registeredNames);

  const changedCore = [...coreHandlers.entries()]
    .filter(([name, implementation]) => !registeredNameSet.has(name) || registeredHandlers[name] !== implementation)
    .map(([name]) => name)
    .sort();
  if (changedCore.length > 0) {
    throw new Error(`External command admission rejected replaced or removed core handlers: ${changedCore.join(', ')}`);
  }

  const expectedAdded = [...new Set(extraTools.map(tool => tool.name).filter(name => !coreHandlers.has(name)))].sort();
  const actualAdded = registeredNames.filter(name => !coreHandlers.has(name));
  if (!sameNames(expectedAdded, actualAdded)) {
    throw new Error(
      `External command admission requires exact extraTools/registered-handler parity ` +
      `(tools=${expectedAdded.join(',') || '(none)'}; handlers=${actualAdded.join(',') || '(none)'})`,
    );
  }

  const missing = [...admission.commandNames].filter(name => !registeredNameSet.has(name)).sort();
  if (missing.length > 0) {
    throw new Error(`External command admission rejected missing registered handlers: ${missing.join(', ')}`);
  }
}
