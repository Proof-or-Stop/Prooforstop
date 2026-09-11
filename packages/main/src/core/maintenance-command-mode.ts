/** Shared preview/execute semantics for raw admission and typed handlers. No IO. */
export const MAINTENANCE_PREVIEW_COMMANDS = [
  'story_reconcile', 'quorum_prune', 'capability_release_backfill', 'verification_evidence_refresh_stale',
] as const;
type MaintenancePreviewCommand = typeof MAINTENANCE_PREVIEW_COMMANDS[number];

export function isMaintenancePreviewCommand(command: string): command is MaintenancePreviewCommand {
  return (MAINTENANCE_PREVIEW_COMMANDS as readonly string[]).includes(command);
}

export function maintenanceCommandWrites(
  command: MaintenancePreviewCommand,
  args: { dryRun?: unknown; apply?: unknown },
  rawAdmission = false,
): boolean {
  const boolean = (name: 'dryRun' | 'apply'): boolean | undefined => {
    const value = args[name];
    if (value === undefined || typeof value === 'boolean') return value;
    if (rawAdmission && (value === 'true' || value === 'false')) return value === 'true';
    throw new Error(`${command}: ${name} must be a boolean`);
  };
  const dryRun = boolean('dryRun');
  if (command === 'story_reconcile') return dryRun === false;
  if (command === 'verification_evidence_refresh_stale') return dryRun !== true;
  const apply = boolean('apply');
  if (apply === true && dryRun === true) {
    throw new Error(`${command}: pass either apply:true or dryRun:true, not both`);
  }
  if (command === 'quorum_prune') {
    if (apply === false && dryRun === false) throw new Error('quorum_prune: apply:false and dryRun:false contradict each other');
    return apply === true || dryRun === false;
  }
  // Backfill has always required explicit apply; dryRun:false alone does not execute.
  return apply === true;
}
