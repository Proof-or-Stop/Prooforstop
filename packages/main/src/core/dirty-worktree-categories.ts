// Pure data shared by the classifier and its eager policy coverage check.
// Keep this leaf free of runtime imports so either public module can load first.
export const DIRTY_WORKTREE_CATEGORIES = [
  'proof_or_stop_metadata_changes',
  'runtime_artifact_changes',
  'declared_artifact_changes',
  'material_source_changes',
  'fixture_changes',
  'unexpected_dirty_files',
] as const;
