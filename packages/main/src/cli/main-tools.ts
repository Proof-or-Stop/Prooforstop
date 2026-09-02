import type { ZodType } from 'zod';

export interface ToolDef {
  name: string;
  /** Short description shown in the proof-or-stop help command list. */
  description: string;
  /** Full prompt shown in proofOrStop <cmd> --help. Optional; defaults to showing description only. */
  longHelp?: string;
  schema: Record<string, ZodType>;
}
