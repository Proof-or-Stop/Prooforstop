import type { ZodType } from 'zod';

export interface ToolDef {
  name: string;
  /** Internal commands remain dispatchable but are omitted from ordinary discovery/help catalogs. */
  visibility?: 'public' | 'internal';
  /** Short description shown in the proof-or-stop help command list. */
  description: string;
  /** Full prompt shown in proofOrStop <cmd> --help. Optional; defaults to showing description only. */
  longHelp?: string;
  /** Copyable JSON bodies shown after schema details. They must satisfy this tool's Zod schema. */
  examples?: Array<{ title: string; body: Record<string, unknown> }>;
  schema: Record<string, ZodType>;
}

/** Public discovery view; dispatch registries deliberately retain internal continuations. */
export function publicToolCatalog(tools: readonly ToolDef[]): ToolDef[] {
  return tools.filter(tool => tool.visibility !== 'internal');
}
