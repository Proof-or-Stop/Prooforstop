import { z } from 'zod';

export const ReviewerBatchAdmitArgsSchema = z.object({
  storyId: z.string().min(1),
  epochId: z.string().min(1).optional(),
  wave: z.number().int().positive().optional(),
  assignments: z.array(z.discriminatedUnion('kind', [
    z.object({ lane: z.string().min(1), kind: z.literal('managed'), host: z.enum(['codex', 'claude']) }).strict(),
    z.object({ lane: z.string().min(1), kind: z.literal('native') }).strict(),
  ])).min(1),
  retryFromGeneration: z.number().int().positive().optional().describe('Explicit owner retry of this failed or expired generation; duplicate requests reuse its successor.'),
  json: z.boolean().optional(),
}).strict();
export type ReviewerBatchAdmitArgs = z.infer<typeof ReviewerBatchAdmitArgsSchema>;
