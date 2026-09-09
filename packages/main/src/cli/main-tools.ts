import type { ZodType } from 'zod';

export interface ToolDef {
  name: string;
  /** Internal commands remain dispatchable but are omitted from ordinary discovery/help catalogs. */
  visibility?: 'public' | 'internal';
  /** Short description shown in the proof-or-stop help command list. */
  description: string;
  /** Full prompt shown in proofOrStop <cmd> --help. Optional; defaults to showing description only. */
  longHelp?: string;
  schema: Record<string, ZodType>;
}

/** Public discovery view; dispatch registries deliberately retain internal continuations. */
export function publicToolCatalog(tools: readonly ToolDef[]): ToolDef[] {
  return tools.filter(tool => tool.visibility !== 'internal');
}
