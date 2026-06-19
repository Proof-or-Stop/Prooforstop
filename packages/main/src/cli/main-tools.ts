import type { ZodType } from 'zod';

export interface ToolDef {
  name: string;
  /** Short description shown in the lattice help command list. */
  description: string;
  /** Full prompt shown in lattice <cmd> --help. Optional; defaults to showing description only. */
  longHelp?: string;
  schema: Record<string, ZodType>;
}
