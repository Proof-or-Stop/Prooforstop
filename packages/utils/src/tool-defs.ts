/**
 * Auxiliary tool CLI registry provided by @proof-or-stop/utils.
 * Passed to the main package's runCli by a bootstrap script and merged with
 * the main package's own mainToolDefs.
 */
import { z } from 'zod';
import type { ToolDef } from '@proof-or-stop/core/extension-api';

export const utilsToolDefs: ToolDef[] = [
  // Trace / diagnose
  { name: 'aux_diagnose', description: 'Auto-diagnose a failing case root cause via trace diff and git diff', schema: {
    caseName: z.string().describe('Case name'),
    fixturePath: z.string().optional().describe('Fixture path; optional'),
  }},
  { name: 'aux_trace', description: 'Extract architecture from trace data: logic lines, impact graph, blind zones', schema: {
    format: z.enum(['json', 'mermaid']).optional().describe('Output format; defaults to json'),
  }},

  // Metadata scan / query
  { name: 'aux_scan', description: 'Scan metadata and validate compliance', schema: {
    format: z.enum(['json','markdown']).optional().describe('Output format'),
    type: z.string().optional().describe('Filter by type'), priority: z.string().optional().describe('Filter by priority'),
    id: z.string().optional().describe('Filter by task ID'),
  }},
  { name: 'aux_detail', description: 'Show file details: signatures, properties, imports', schema: {
    files: z.array(z.string()).describe('Array of file names, relative to scanRoot'),
  }},
  { name: 'aux_sync', description: 'Sync metadata: extract/clean/validate/status', schema: {
    direction: z.enum(['extract','clean','validate','status']).describe('Operation direction'),
  }},
  { name: 'aux_coverage', description: 'Check task coverage for a Story', schema: {
    storyId: z.union([z.string(), z.array(z.string())]).describe('Story ID or array of IDs'),
  }},
  { name: 'aux_locate', description: 'Fuzzy-find a task by keyword', schema: {
    query: z.string().describe('Query string'),
  }},

  // Tool usage statistics
  { name: 'tool_status', description: 'Report tool usage from activity.jsonl across .proof-or-stop/ and docs/story/', schema: {
    source: z.enum(['cli','claude','codex','all']).optional().describe('Data source; defaults to all'),
    role: z.string().optional().describe('Filter by activity role, such as reviewer / intent / main'),
    days: z.number().optional().describe('Time window in days; defaults to 30'),
    limit: z.number().optional().describe('Top N; defaults to 20'),
    format: z.enum(['text','json']).optional().describe('Output format; defaults to text'),
  }},
];

export const utilsOwnershipClasses = {
  aux_coverage: 'readOnly',
  aux_detail: 'readOnly',
  aux_diagnose: 'mainSharedMutating',
  aux_locate: 'readOnly',
  aux_scan: 'readOnly',
  aux_sync: 'mainSharedMutating',
  aux_trace: 'readOnly',
  tool_status: 'readOnly',
} as const;

export const utilsAllowedPhases = {
  aux_coverage: 'all',
  aux_detail: 'all',
  aux_diagnose: ['DEV'],
  aux_locate: 'all',
  aux_scan: 'all',
  aux_sync: ['DEV'],
  aux_trace: 'all',
  tool_status: 'all',
} as const;
