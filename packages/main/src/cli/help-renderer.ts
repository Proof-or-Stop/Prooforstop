import {
  ZodArray,
  ZodBoolean,
  ZodEnum,
  ZodNumber,
  ZodObject,
  ZodOptional,
  ZodString,
  type ZodIssue,
  type ZodType,
  ZodUnion,
} from 'zod';
import { isCommandAllowed } from '../core/config.js';
import { getCommandPolicy, type CommandPolicy } from '../core/command-policy.js';
import {
  detectLatticeBrand,
  formatLatticeProductLine,
} from '../core/lattice-brand.js';
import { SESSION_BRIEF_FOOTER } from '../cli-prompts.js';
import type { ToolDef } from './main-tools.js';

export interface ActiveStoryForHelp {
  storyId: string;
  phase: string;
}

export type OwnerLeaseHelpBlockCallback = (cmd: string) => string | null;

export type HelpOutputOptions = {
  stream?: { write(chunk: string): unknown };
  includeFooter?: boolean;
  ownerLeaseHelpBlock: OwnerLeaseHelpBlockCallback;
};

export type GlobalHelpOptions = {
  tools: ToolDef[];
  activeStory?: ActiveStoryForHelp | null;
  phaseTools?: Record<string, string[]>;
  ownerLeaseHelpBlock: OwnerLeaseHelpBlockCallback;
};

function describeType(t: ZodType): string {
  if (t instanceof ZodOptional) return describeType((t as any)._def.innerType);
  if (t instanceof ZodString) return 'string';
  if (t instanceof ZodNumber) return 'number';
  if (t instanceof ZodBoolean) return 'boolean';
  if (t instanceof ZodEnum) return ((t as any).options || []).join('|');
  if (t instanceof ZodArray) return 'array';
  if (t instanceof ZodObject) return 'object';
  if (t instanceof ZodUnion) return 'string|array';
  return 'any';
}

function getDesc(t: ZodType): string {
  return (t as any).description || '';
}

function isHiddenHelpEntry(t: ZodType): boolean {
  return getDesc(t).includes('@help-hidden');
}

function unwrapOptional(t: ZodType): ZodType {
  return t instanceof ZodOptional ? (t as any)._def.innerType : t;
}

function objectShape(t: ZodObject<any>): Record<string, ZodType> {
  const anyType = t as any;
  const shape = anyType.shape ?? anyType._def?.shape;
  return typeof shape === 'function' ? shape() : shape || {};
}

function arrayElement(t: ZodArray<any>): ZodType | null {
  const anyType = t as any;
  return anyType.element || anyType._def?.type || null;
}

function nestedSchemaLines(t: ZodType, prefix: string, indent = '      '): string[] {
  const inner = unwrapOptional(t);
  if (inner instanceof ZodArray) {
    const element = arrayElement(inner);
    if (!element) return [];
    const elementInner = unwrapOptional(element);
    if (elementInner instanceof ZodObject) {
      return nestedSchemaLines(elementInner, `${prefix}[]`, indent);
    }
    return [`${indent}${prefix}[]: ${describeType(elementInner)} ${getDesc(elementInner)}`.trimEnd()];
  }
  if (!(inner instanceof ZodObject)) return [];
  const shape = objectShape(inner);
  const lines: string[] = [];
  for (const [key, child] of Object.entries(shape)) {
    const optional = child instanceof ZodOptional;
    const childInner = unwrapOptional(child);
    const path = prefix ? `${prefix}.${key}` : key;
    lines.push(`${indent}${path}${optional ? '?' : ''}: ${describeType(child)} ${getDesc(child)}`.trimEnd());
    if (childInner instanceof ZodObject || childInner instanceof ZodArray) {
      lines.push(...nestedSchemaLines(childInner, path, indent + '  '));
    }
  }
  return lines;
}

export function normalizeHelpText(text: string | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * @task B-e3d9
 * @checklist CHK-002
 * @title derive supportsDryRun help from live schema and command policy
 * @type refactor
 * @priority high
 * @description
 *   The abandoned cc-learnings supportsDryRun field is not the main CLI
 *   contract. Real dry-run behavior already lives in ToolDef schema flags
 *   (`dryRun` / `confirm`), command descriptions, and COMMAND_POLICIES
 *   operator-safety prose. Help derives the surfaced contract from those live
 *   inputs so we do not create a second supportsDryRun registry.
 * @changes
 *   - [CHK-002] Summarize supportsDryRun-equivalent behavior in lattice <command> --help
 *   - [CHK-002] Keep dry-run truth derived from schema/policy instead of speculative metadata
 * @test dangerous-command-guardrails
 */
export function dryRunHelpLine(tool: ToolDef, policy?: CommandPolicy): string | null {
  const toolDescription = normalizeHelpText(tool.description);
  const policyReason = normalizeHelpText(policy?.reason);
  const policyReplacement = normalizeHelpText(policy?.replacement);
  const dryRunField = tool.schema.dryRun;
  const dryRunDescription = dryRunField ? normalizeHelpText(getDesc(dryRunField)) : '';
  const combined = [toolDescription, dryRunDescription, policyReason, policyReplacement]
    .filter(Boolean)
    .join(' ');
  const hasConfirmFlag = Object.prototype.hasOwnProperty.call(tool.schema, 'confirm');

  if (dryRunField) {
    if (/始终为 dry-run|always[- ]on|always dry[- ]run/i.test(combined)) {
      return `  Dry-run: always-on. ${dryRunDescription || 'This command is projection-only and never executes the side-effect path.'}`;
    }
    if (/默认 dry run|默认 dry-run|default dry run|default dry-run|默认 true/i.test(combined)) {
      return `  Dry-run: default-on via --dryRun=true. ${dryRunDescription || 'Pass --dryRun=false to execute the real path.'}`;
    }
    const confirmNote = hasConfirmFlag ? ' Real execution may also require --confirm.' : '';
    return `  Dry-run: optional via --dryRun. ${dryRunDescription || 'Preview the command without executing the real path.'}${confirmNote}`;
  }

  if (/dry[- ]run/i.test(combined)) {
    return '  Dry-run: always-on. This command only projects guidance and does not execute the side-effect path.';
  }

  return null;
}

export function printToolHelp(tool: ToolDef, options: HelpOutputOptions) {
  const brand = detectLatticeBrand();
  const out = (line = '') => {
    if (options.stream) options.stream.write(`${line}\n`);
    else console.log(line);
  };
  const includeFooter = options.includeFooter !== false;
  const policy = getCommandPolicy(tool.name);
  const dryRunLine = dryRunHelpLine(tool, policy);

  out(`\n  ${brand.primaryBin} ${tool.name} — ${tool.description}\n`);
  out(`  ${formatLatticeProductLine(brand)}\n`);

  // If longHelp exists for a core command, print the full prompt first.
  if (tool.longHelp) {
    out(tool.longHelp);
    out('');
  }

  const entries = Object.entries(tool.schema).filter(([, type]) => !isHiddenHelpEntry(type));
  if (entries.length === 0) {
    out('  No arguments\n');
    out(`  Usage: ${brand.primaryBin} ${tool.name}`);
    if (dryRunLine) out(dryRunLine);
    const ownerBlock = options.ownerLeaseHelpBlock(tool.name);
    if (ownerBlock) out(ownerBlock);
    if (includeFooter) out(SESSION_BRIEF_FOOTER);
    return;
  }
  out('  Arguments:');
  const maxN = Math.max(...entries.map(([k]) => k.length));
  for (const [name, type] of entries) {
    const opt = type instanceof ZodOptional;
    const req = opt ? '' : ' *';
    const inner = type instanceof ZodOptional ? (type as any)._def.innerType : type;
    const isComplex = inner instanceof ZodArray || inner instanceof ZodObject;
    const flagHint = isComplex ? '(JSON)' : '';
    out(`    --${name.padEnd(maxN + 2)} ${describeType(type).padEnd(16)} ${getDesc(type)}${req} ${flagHint}`);
    if (isComplex) {
      for (const line of nestedSchemaLines(type, name)) out(line);
    }
  }
  const required = entries.filter(([, t]) => !(t instanceof ZodOptional));
  const optional = entries.filter(([, t]) => t instanceof ZodOptional);
  const reqParts = required.map(([k]) => `--${k}=value`);
  const optParts = optional.map(([k]) => {
    const inner = (entries.find(([n]) => n === k)?.[1] as any);
    const base = inner instanceof ZodOptional ? (inner as any)._def.innerType : inner;
    return base instanceof ZodBoolean ? `[--${k}]` : `[--${k}=value]`;
  });
  out(`\n  Usage: ${brand.primaryBin} ${tool.name} ${[...reqParts, ...optParts].join(' ')}`);
  out('  (* = required)');
  if (dryRunLine) out(dryRunLine);
  const ownerBlock = options.ownerLeaseHelpBlock(tool.name);
  if (ownerBlock) out(ownerBlock);
  if (includeFooter) out(SESSION_BRIEF_FOOTER);
}

function formatValidationIssue(issue: ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `  ${path}: ${issue.message}`;
}

export function printValidationFailure(tool: ToolDef, issues: ZodIssue[], ownerLeaseHelpBlock: OwnerLeaseHelpBlockCallback) {
  const lines = issues.map(formatValidationIssue);
  process.stderr.write('Argument validation failed:\n');
  for (const line of lines) process.stderr.write(`${line}\n`);
  printToolHelp(tool, { stream: process.stderr, includeFooter: false, ownerLeaseHelpBlock });
  process.stderr.write('\nArgument validation failed (summary):\n');
  for (const line of lines) process.stderr.write(`${line}\n`);
}

export function printHelp(options: GlobalHelpOptions) {
  const { tools, activeStory, phaseTools } = options;
  const brand = detectLatticeBrand();
  console.log(`\n  ${formatLatticeProductLine(brand)} — CLI-first project workflow and host migration surface\n`);
  console.log(`  Entrypoint: ${brand.primaryBin}\n`);
  console.log(`  Usage: ${brand.primaryBin} <command> --key=value         Run command`);
  console.log(`        ${brand.primaryBin} <command> --help              View arguments`);
  console.log(`        ${brand.primaryBin} help                          Show this help`);
  console.log(`        ${brand.primaryBin} --version                     Show version`);
  console.log(`        ${brand.primaryBin} --root <path> ...             Specify project root directory\n`);

  if (activeStory) {
    console.log(`  Current Story: ${activeStory.storyId}  phase: ${activeStory.phase}\n`);
  }

  // Known prefix maps to display group name (special cases first).
  const KNOWN_GROUP: Record<string, string> = {
    story: 'Story',
    checklist: 'Checklist',
    bug: 'Bug',
    test: 'Test',
    validate: 'Validate',
    status: 'Status',
    serve: 'Serve',
    aux: 'Aux',
    evaluate: 'Evaluate',
    dashboard: 'Session',
    session: 'Session',
    audit: 'Audit',
    check: 'Check',
    release: 'Release',
    host: 'Host',
    lattice: 'Proofbound',
    rollout: 'Proofbound',
    authority: 'Authority',
    conduit: 'Conduit',
  };
  // Display order for known groups; groups not in the list (from extras) are appended alphabetically.
  const KNOWN_ORDER = ['Host', 'Proofbound', 'Authority', 'Conduit', 'Story', 'Review', 'Checklist', 'Grill', 'Bug', 'Test', 'Validate', 'Evaluate', 'Workflow', 'Status', 'Check', 'Serve', 'Session', 'Aux', 'Audit'];

  const groups: Record<string, ToolDef[]> = {};
  for (const t of tools) {
    // When an active story exists, list only commands available in the current phase.
    if (activeStory && !isCommandAllowed(t.name, activeStory.phase, phaseTools)) continue;
    const p = t.name.split('_')[0];
    let g: string;
    if (t.name === 'story_review' || t.name === 'story_review_dismiss') g = 'Review';
    else if (KNOWN_GROUP[p]) g = KNOWN_GROUP[p];
    else g = p.charAt(0).toUpperCase() + p.slice(1); // Unknown prefix: capitalize first letter.
    (groups[g] = groups[g] || []).push(t);
  }
  const filteredTools = activeStory ? tools.filter(t => isCommandAllowed(t.name, activeStory.phase, phaseTools)) : tools;
  const maxN = Math.max(...filteredTools.map(t => t.name.length), 0);

  const presentGroups = Object.keys(groups);
  const orderedGroups = [
    ...KNOWN_ORDER.filter(g => groups[g]),
    ...presentGroups.filter(g => !KNOWN_ORDER.includes(g)).sort(),
  ];
  for (const g of orderedGroups) {
    console.log(`  ${g}:`);
    for (const t of groups[g]) console.log(`    ${t.name.padEnd(maxN + 2)} ${t.description}`);
  }
  console.log(`
  Development flow:
    ── PLAN ──
    1. lattice story_create '{"name":"x","title":"..","description":"..","type":"feature","priority":"high","checklist":[{"title":"what to do","context":"context"}]}'
    2. lattice story_advance --storyId=B-xxx --phase=INIT_CHECK # Create local worktree/local branch
    3. cd .worktrees/B-xxx
    4. lattice story_review --storyId=B-xxx                     # Review passes, then enter DEV
    5. lattice story_advance --storyId=B-xxx --phase=DEV

    ── DEV ──
    6. Implement the code and its verification (fixtures, project-native tests, or optional validate.ts)
    7. lattice validate                                         # Verification (auto-detect by project language or read config)
    8. lattice checklist_update --storyId=B-xxx --itemId=CHK-001 --status=done

    ── REVIEW ──
    9. lattice story_advance --storyId=B-xxx --phase=REVIEW    # Enter code review
   10. Proofbound reviewer reviews code and raises findings       # critical/high must resolve

    ── TEST → DONE ──
   11. lattice story_advance --storyId=B-xxx --phase=TEST
   12. lattice story_advance --storyId=B-xxx --phase=DONE     # Merge back to local main and clean worktree

  Parallelism and branch discipline:
    Proofbound parallel development uses only local git worktrees plus local branches; do not create or push GitHub/origin feature branches.
    If remote publishing is needed, first let DONE merge back to local main, confirm main is clean, then a human explicitly runs lattice release_approve_push --confirm, and then manually runs git push origin main.

  Initialize a new project:
    lattice init                          # Initialize Proofbound project state in the current directory

  Tip: use --key=value for simple arguments; use JSON format for complex arguments (array/object).
  Error? Use lattice <command> --help to view complete argument help.
`);
}
