/**
 * Shared zod re-export for monorepo packages that must hand schemas back to
 * @koala-agent/core at runtime.
 *
 * Why this exists:
 * - cli-engine uses z.object(tool.schema) and several instanceof checks.
 * - If an extension package resolves a different physical `zod` install, its
 *   schemas fail runtime validation even when the API shape looks identical.
 *
 * Importing zod through this file forces extension packages to share the same
 * module instance that core itself resolves.
 */
export {
  z,
  ZodType,
  ZodOptional,
  ZodEnum,
  ZodArray,
  ZodUnion,
  ZodString,
  ZodBoolean,
  ZodNumber,
  ZodObject,
} from 'zod';
