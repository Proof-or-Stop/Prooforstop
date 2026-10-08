/**
 * PLAN coverage matrix (old-PoS runs 24-29, bench-staging/oldpos/run28-29-analysis.md
 * §3.3 / §5.1 B): rows the request text demands that no intent states.
 *
 * Each finding round costs 15-27 min and 10-17M tokens. Of the R1/R2 findings
 * in runs 24-29, most were a value class the checklist never tested on one
 * operation or syntax form: a read-side error that crashed on the assignment
 * path (28/F-002), `[::]` / `[:e:]` panics (24/F-001, 29/F-001), omitted-bound
 * runtime rows missing (27/F-001), assignment tested only with forward explicit
 * ASCII selections (29/F-002, F-003), explicit `null` treated as omitted
 * (24/F-005, 28/F-001). These checks demand those rows in PLAN, where they cost
 * one authoring turn, instead of a review round. They add rows; they never
 * remove a review.
 *
 * Deterministic, and only on request text patterns (each gap lists the request
 * sentences that triggered it):
 *   1. write-mirror: a request sentence makes writes follow reads ("same ...
 *      semantics as read slicing" in an assignment section). Every value class
 *      an intent tests on the read side (omitted / explicit null / 0 / negative /
 *      non-numeric per operand position, multibyte text, empty selection) needs
 *      a write-side intent with that class.
 *   2. omit-combination: the request lists forms of an n-part syntax with
 *      omitted parts (`value[:end:step]`, `value[::step]`). Every omission
 *      pattern of the n parts (2^n: `[start:end:step]` .. `[::]`) needs a
 *      runtime (read or write) intent, and a negative value where the request
 *      names one ("Negative step").
 *   3. enumerated-domain: a request sentence that states a value class
 *      (non-numeric, negative, zero-length, step of 0, Unicode/runes) for an
 *      enumerated list of operand positions (`end` or `step`), receivers
 *      (array/string) or forms (single index, two-part, three-part) needs one
 *      intent per member, in the operation its section is about; a non-numeric
 *      operand that can be omitted also needs an explicit-null intent (omitted
 *      and explicit null are different inputs).
 * Request literals (error messages, quoted examples) are the story_create
 * literal pre-check's (core/story-request.ts); the general case of each check
 * is a scope-plan reviewer rule (renderCoverageMatrixRule).
 *
 * A gap is a story_review `missing_coverage_row` blocker in PLAN and a
 * pre-scope authoring row in `next` (one exact checklist_update per target
 * item with a placeholder intent per missing row). A gap that does not apply
 * is excluded by an item excludes entry that names its key with a reason.
 * Only Stories with a readable request.md are checked.
 */
import type { ChecklistItem, VerificationIntentDerivation } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { requestSections } from './intent-derivation.js';

export const MISSING_COVERAGE_ROW = 'missing_coverage_row';
export const COVERAGE_GAP_PREFIX = 'coverage';

type Op = 'parse' | 'read' | 'write';
type Receiver = 'array' | 'string';
type Shape = 'index' | 'range2' | 'range3';
export type CoverageRule = 'write-mirror' | 'omit-combination' | 'enumerated-domain';

/** Value classes a row can carry; positional ones are `<kind>:<operand position>`. */
const POSITIONAL_KINDS = ['omitted', 'null', 'zero', 'negative', 'nonnumeric'] as const;
const MIRROR_FLAT = ['multibyte', 'empty-selection'] as const;

interface RowFeatures {
  ref: string;
  itemId: string;
  op: Op | null;
  classes: Set<string>;
  receivers: Set<Receiver>;
  shapes: Set<Shape>;
  /** Omission patterns of the request's n-part syntax, e.g. `[start::step]`. */
  patterns: Set<string>;
}

export interface CoverageRequirement {
  rule: CoverageRule;
  /** read / write, or eval (either). */
  op: 'read' | 'write' | 'eval';
  classes: string[];
  pattern?: string;
  receiver?: Receiver;
  shape?: Shape;
  /** Stable name of the row ("coverage write: negative step"); an excludes entry naming it excludes the row. */
  key: string;
  /** The request sentences that triggered it. */
  sentences: string[];
}

export interface CoverageGap extends CoverageRequirement {
  /** The item whose intents most resemble the missing row (where the placeholder goes). */
  itemId: string;
  /** An input shape that would satisfy the row. */
  example: string;
}

type CheckedItem = Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent'> & { title?: string; excludes?: readonly string[] };

export interface CoverageStatus { requirement: CoverageRequirement; satisfiedBy: string[]; excludedBy: string | null }

// ---------------------------------------------------------------------------
// Request side

interface SyntaxFamily { arity: number; names: string[]; omittable: boolean; forms: string[] }

const squashLower = (text: string): string => text.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Top-level `:` parts of a bracket body; null when it holds a top-level `,` (a list, not an index). */
function splitIndexParts(body: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const char of body) {
    if (quote) { current += char; if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if ('[{('.includes(char)) depth += 1;
    if (']})'.includes(char)) depth -= 1;
    if (depth === 0 && char === ',') return null;
    if (depth === 0 && char === ':') { parts.push(current.trim()); current = ''; continue; }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

/** Index expressions `x[...]` of a text (a `[` right after a word, `]`, `)` or quote), with what follows them. */
function indexExpressions(text: string): Array<{ parts: string[]; after: string }> {
  const out: Array<{ parts: string[]; after: string }> = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '[') continue;
    const attached = index > 0 && /[\w\])"'\u0080-￿]/.test(text[index - 1]!);
    const introduced = /\b(?:at|with|by|index(?:ed)?|slice[sd]?)\s+$/i.test(text.slice(0, index));
    let depth = 0;
    let end = -1;
    for (let cursor = index; cursor < text.length; cursor += 1) {
      if (text[cursor] === '[') depth += 1;
      else if (text[cursor] === ']') { depth -= 1; if (depth === 0) { end = cursor; break; } }
    }
    if (end < 0) break;
    const parts = splitIndexParts(text.slice(index + 1, end));
    // A detached bracket is an index only when it holds a slice (`:`) or follows "at/with/indexed".
    if (parts && (attached || introduced || parts.length > 1)) out.push({ parts, after: text.slice(end + 1, end + 4) });
  }
  return out;
}

/**
 * The request's n-part bracket syntax (n >= 2, largest arity whose request
 * forms omit a part), its operand names from the all-identifier form
 * (`value[start:end:step]`), else part1..n.
 */
export function requestSyntaxFamily(requestText: string): SyntaxFamily | null {
  const spans = [...requestText.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!);
  const byArity = new Map<number, string[][]>();
  for (const span of spans) {
    for (const expression of indexExpressions(span)) {
      if (expression.parts.length < 2) continue;
      byArity.set(expression.parts.length, [...(byArity.get(expression.parts.length) ?? []), expression.parts]);
    }
  }
  const arities = [...byArity.keys()].sort((a, b) => b - a);
  for (const arity of arities) {
    const forms = byArity.get(arity)!;
    if (!forms.some(parts => parts.some(part => part === ''))) continue;
    const named = forms.find(parts => parts.every(part => /^[A-Za-z_]\w*$/.test(part)));
    const names = named ? named.map(part => part.toLowerCase()) : Array.from({ length: arity }, (_, at) => `part${at + 1}`);
    return { arity, names, omittable: true, forms: forms.map(parts => `[${parts.join(':')}]`) };
  }
  return null;
}

/** Operand names per arity: the family's for its arity, its first two for a two-part range, `index` for one. */
function namesFor(arity: number, family: SyntaxFamily | null): string[] {
  if (family && arity === family.arity) return family.names;
  if (arity === 2) return family && family.arity > 2 ? family.names.slice(0, 2) : ['start', 'end'];
  if (arity === 1) return ['index'];
  return Array.from({ length: arity }, (_, at) => (family?.names[at] ?? `part${at + 1}`));
}

/** `last`: the operand is the last of a 3+-part form (a step), the only one where 0 is a class of its own. */
function partClasses(part: string, name: string, last: boolean): string[] {
  const value = part.replace(/^\((.*)\)$/, '$1').trim();
  if (value === '') return [`omitted:${name}`];
  if (/^(?:null|nil|none|undefined)$/i.test(value)) return [`null:${name}`, `nonnumeric:${name}`];
  if (/^-\s*\d/.test(value)) return [`negative:${name}`];
  if (/^0+$/.test(value)) return last ? [`zero:${name}`] : [];
  if (/^\{.*\}$|^".*"$|^'.*'$|^(?:true|false)$|^\[.*\]$/i.test(value)) return [`nonnumeric:${name}`];
  return [];
}

/** Non-ASCII letters or emoji (not arrows or dashes), a U+ code point, or the words. */
const MULTIBYTE = /(?![\x00-\x7f])[\p{L}\p{M}\p{Extended_Pictographic}]|\bU\+[0-9A-Fa-f]{4,6}\b|\\u[0-9A-Fa-f]{4}|\b(?:unicode|multi-?byte|non-ascii|utf-?8|cjk|emoji|accented|acute|grave|umlaut|diaeresis|cedilla|diacritics?)\b|\bnot\s+(?:raw\s+)?bytes\b/iu;
const EMPTY_SELECTION = /\bzero-(?:length|index(?:es)?)\b|\bzero\s+(?:[\w-]+\s+){0,2}?(?:indexes|indices|targets|elements)\b|\bselects?\s+(?:zero|no)\s+(?:target\s+)?(?:indexes|indices|elements)\b|\bempty\s+(?:range|selection)\b/i;

function listNames(text: string, names: readonly string[]): string[] {
  const alt = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(`\\b(${alt})\\b`, 'gi'))) found.push(match[1]!.toLowerCase());
  return [...new Set(found)];
}

/** Class words of prose rows (run 27's owner wrote intents as prose). */
function proseClasses(desc: string, names: readonly string[]): string[] {
  const out: string[] = [];
  if (!names.length) return out;
  const alt = names.join('|');
  const list = `((?:${alt})(?:\\s*(?:,|/|\\band\\b|\\bor\\b)\\s*(?:${alt}))*)`;
  const add = (kind: string, text: string): void => { for (const name of listNames(text, names)) out.push(`${kind}:${name}`); };
  for (const match of desc.matchAll(new RegExp(`\\bnon-?numeric\\s+(?:(?:array|string|range|slice|index)\\s+)?\`?${list}`, 'gi'))) add('nonnumeric', match[1]!);
  for (const match of desc.matchAll(new RegExp(`\\bnegative\\s+${list}`, 'gi'))) add('negative', match[1]!);
  for (const match of desc.matchAll(new RegExp(`\\bomit(?:ted|s|ting)?\\s+${list}`, 'gi'))) add('omitted', match[1]!);
  for (const match of desc.matchAll(new RegExp(`\\b${list}\\s+(?:components?\\s+|bounds?\\s+)?(?:is\\s+|are\\s+)?omitted\\b`, 'gi'))) add('omitted', match[1]!);
  for (const match of desc.matchAll(new RegExp(`\\b(?:explicit\\s+)?null\\s+${list}`, 'gi'))) add('null', match[1]!);
  const last = names.at(-1)!;
  if (new RegExp(`\\b${last}\\s+(?:of\\s+)?\`?0\`?(?![\\w.])|\\bzero\\s+${last}\\b`, 'i').test(desc)) out.push(`zero:${last}`);
  if (new RegExp(`\\b(?:backwards?|reversed?|reverses)\\b`, 'i').test(desc) && names.length >= 3) out.push(`negative:${last}`);
  return out;
}

const PARSE_ROW = /\bpars(?:e|es|ed|ing|er)\b|\bAST\b|\bstringif|\bString\(\)/i;

const receiversOf = (text: string): Set<Receiver> => {
  const receivers = new Set<Receiver>();
  if (/\barrays?\b|\bARRAY\b|(?:^|[\s=(;])\[\s*-?\d+\s*,/.test(text)) receivers.add('array');
  if (/\bstrings?\b|\bSTRING\b|"[^"\n]*"\s*\[|\b\w+\s*=\s*"/.test(text)) receivers.add('string');
  return receivers;
};

/** `itemTitle`: a row that names no receiver takes its item title's (an item "String ... assignment"). */
function rowFeatures(ref: string, itemId: string, desc: string, family: SyntaxFamily | null, itemTitle = ''): RowFeatures {
  const classes = new Set<string>();
  const shapes = new Set<Shape>();
  const patterns = new Set<string>();
  let write = false;
  for (const expression of indexExpressions(desc)) {
    const arity = expression.parts.length;
    const names = namesFor(arity, family);
    if (/^\s*=(?!=)/.test(expression.after)) write = true;
    shapes.add(arity === 1 ? 'index' : arity === 2 ? 'range2' : 'range3');
    expression.parts.forEach((part, at) => {
      for (const value of partClasses(part, names[at] ?? `part${at + 1}`, arity >= 3 && at === arity - 1)) classes.add(value);
    });
    if (arity >= 2) {
      const [start, end] = expression.parts;
      // Numeric start >= end selects nothing unless a negative step walks backward.
      const step = arity >= 3 ? expression.parts[arity - 1]! : '';
      if (start !== undefined && end !== undefined && /^\d+$/.test(start) && /^\d+$/.test(end) && Number(start) >= Number(end) && !/^\(?-/.test(step)) classes.add('empty-selection');
    }
    if (family && arity === family.arity) patterns.add(`[${expression.parts.map((part, at) => (part === '' ? '' : family.names[at])).join(':')}]`);
  }
  const familyNames = family?.names ?? [];
  // Prose class words only when the row writes no range: the syntax is exact, prose is ambiguous ("non-numeric omitted step").
  if (![...shapes].some(shape => shape !== 'index')) for (const value of proseClasses(desc, familyNames.length ? familyNames : ['start', 'end', 'step'])) classes.add(value);
  if (MULTIBYTE.test(desc)) classes.add('multibyte');
  if (EMPTY_SELECTION.test(desc)) classes.add('empty-selection');
  if (/\bsingle[- ]index\b|\bindexed\s+at\b|\bindex\s+-?\d|\b(?:negative|string)\s+index\b|\bindexing\b/i.test(desc)) shapes.add('index');
  if (/\btwo-part\b/i.test(desc)) shapes.add('range2');
  if (/\bthree-part\b|\bstepped\b/i.test(desc)) shapes.add('range3');
  if (/\bassign/i.test(desc)) write = true;
  let receivers = receiversOf(desc);
  if (!receivers.size) receivers = receiversOf(itemTitle);
  if (classes.has('multibyte')) receivers.add('string');
  const parse = PARSE_ROW.test(desc) || /(?:->|→)\s*`?\(\w+\[/.test(desc);
  const op: Op | null = write ? 'write' : parse ? 'parse' : (shapes.size || /\b(?:slic|index|range|read)/i.test(desc)) ? 'read' : null;
  return { ref, itemId, op, classes, receivers, shapes, patterns };
}

function checklistRows(items: readonly CheckedItem[], family: SyntaxFamily | null): RowFeatures[] {
  const rows: RowFeatures[] = [];
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    for (const lane of VERIFICATION_LANES) {
      for (const [index, intent] of (item.verificationIntent?.[lane] ?? []).entries()) {
        rows.push(rowFeatures(intent.id ?? `${item.id}:${lane}:${index}`, item.id, String(intent.desc ?? ''), family, item.title ?? ''));
      }
    }
  }
  return rows;
}

interface RequestSentence { text: string; section: number; heading: string }

function requestSentences(requestText: string): RequestSentence[] {
  const out: RequestSentence[] = [];
  requestSections(requestText).forEach((section, index) => {
    const heading = section.split('\n').find(line => line.trim()) ?? '';
    for (const line of section.split('\n')) {
      const body = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
      if (!body) continue;
      for (const sentence of body.split(/(?<=[.!?])\s+(?=[A-Z])/)) if (sentence.trim()) out.push({ text: sentence.trim(), section: index, heading });
    }
  });
  return out;
}

const sectionOp = (heading: string): Op => (/assign/i.test(heading) ? 'write' : /\bpars|\bAST\b|\bsyntax\b|stringif/i.test(heading) ? 'parse' : 'read');

const SAME_SEMANTICS = /\bsame\b[^.!?\n]{0,80}?\bsemantics?\b|\b(?:works?|behaves?|acts?)\s+(?:just\s+|exactly\s+)?like\b|\bconsistent\s+with\b|\bsame\s+(?:behaviou?r|way)\s+as\b/i;

// ---------------------------------------------------------------------------
// Requirements

const KIND_LABEL: Record<string, string> = {
  omitted: 'omitted', null: 'explicit null', zero: '0', negative: 'negative', nonnumeric: 'non-numeric',
  multibyte: 'multibyte (non-ASCII) text', 'empty-selection': 'empty (zero-length) selection',
};
const SHAPE_LABEL: Record<Shape, string> = { index: 'single index', range2: 'two-part range', range3: 'three-part range' };

export function classLabel(value: string): string {
  const [kind, position] = value.split(':');
  return position ? `${KIND_LABEL[kind!] ?? kind} ${position}` : (KIND_LABEL[kind!] ?? kind!);
}

function requirementKey(requirement: Omit<CoverageRequirement, 'key' | 'sentences'>): string {
  const op = requirement.op === 'eval' ? 'read or write' : requirement.op;
  const what = [requirement.pattern ? `form ${requirement.pattern}` : '', ...requirement.classes.map(classLabel)].filter(Boolean).join(' + ');
  return `${COVERAGE_GAP_PREFIX} ${op}: ${what}${requirement.receiver ? ` on ${requirement.receiver}` : ''}${requirement.shape ? ` via ${SHAPE_LABEL[requirement.shape]}` : ''}`;
}

function satisfies(row: RowFeatures, requirement: CoverageRequirement): boolean {
  if (requirement.op === 'eval' ? row.op !== 'read' && row.op !== 'write' : row.op !== requirement.op) return false;
  if (!requirement.classes.every(value => row.classes.has(value))) return false;
  if (requirement.pattern && !row.patterns.has(requirement.pattern)) return false;
  if (requirement.receiver && !row.receivers.has(requirement.receiver)) return false;
  if (requirement.shape && !row.shapes.has(requirement.shape)) return false;
  return true;
}

/** True when every row that satisfies `a` also satisfies `b` (b is implied by a). */
function implies(a: CoverageRequirement, b: CoverageRequirement): boolean {
  if (b.op !== 'eval' && a.op !== b.op) return false;
  if (b.pattern && a.pattern !== b.pattern) return false;
  if (b.receiver && a.receiver !== b.receiver) return false;
  if (b.shape && a.shape !== b.shape) return false;
  return b.classes.every(value => a.classes.includes(value));
}

function requirement(rule: CoverageRule, fields: Omit<CoverageRequirement, 'rule' | 'key' | 'sentences'>, sentences: string[]): CoverageRequirement {
  const base = { rule, ...fields };
  return { ...base, key: requirementKey(base), sentences };
}

/**
 * `demanded`: the read-side rows the other two rules demand. Their classes are
 * mirrored too, so one authoring pass covers both sides (a read row added for
 * an explicit null would otherwise demand its write mirror only on the next pass).
 */
function writeMirror(rows: RowFeatures[], sentences: RequestSentence[], demanded: readonly CoverageRequirement[], family: SyntaxFamily | null): CoverageRequirement[] {
  const triggers = sentences.filter(sentence => SAME_SEMANTICS.test(sentence.text)
    && /\bassign|\bwrit|\bstore\b|\bset\b/i.test(`${sentence.heading} ${sentence.text}`)
    && /\bread|\bslic|\bget\b|\baccess|\blookup/i.test(sentence.text));
  if (!triggers.length) return [];
  const mirrored = new Set<string>();
  // Range operands only: the same-semantics sentence is about selection, not the single-index form.
  const add = (value: string): void => {
    const [kind, position] = value.split(':');
    if (((POSITIONAL_KINDS as readonly string[]).includes(kind!) && position !== 'index') || (MIRROR_FLAT as readonly string[]).includes(value)) mirrored.add(value);
  };
  for (const row of rows) if (row.op === 'read') row.classes.forEach(add);
  for (const entry of demanded) {
    if (entry.op === 'write') continue;
    entry.classes.forEach(add);
    // An omission pattern omits its empty operands.
    if (entry.pattern && family) entry.pattern.slice(1, -1).split(':').forEach((part, at) => { if (part === '') add(`omitted:${family.names[at]}`); });
  }
  return [...mirrored].sort().map(value => requirement('write-mirror', { op: 'write', classes: [value] }, triggers.map(sentence => sentence.text)));
}

function omitCombinations(requestText: string, family: SyntaxFamily | null, sentences: RequestSentence[]): CoverageRequirement[] {
  if (!family) return [];
  const triggers = sentences.filter(sentence => indexExpressions(sentence.text.replace(/`/g, '')).some(expression => expression.parts.length === family.arity && expression.parts.some(part => part === '')));
  const quoted = triggers.map(sentence => sentence.text);
  const out: CoverageRequirement[] = [];
  for (let mask = 0; mask < 2 ** family.arity; mask += 1) {
    const pattern = `[${family.names.map((name, at) => ((mask >> at) & 1 ? '' : name)).join(':')}]`;
    out.push(requirement('omit-combination', { op: 'eval', classes: [], pattern }, quoted));
  }
  const last = family.names.at(-1)!;
  const negative = sentences.filter(sentence => new RegExp(`\\bnegative\\s+\`?${last}\\b`, 'i').test(sentence.text));
  if (negative.length) out.push(requirement('omit-combination', { op: 'eval', classes: [`negative:${last}`] }, negative.map(sentence => sentence.text)));
  return out;
}

const SENTENCE_KINDS: Array<{ kind: string; test: RegExp; positional: boolean }> = [
  { kind: 'nonnumeric', test: /\bnon-?numeric\b|\bnot\s+numeric\b|\bnon-?number\b/i, positional: true },
  { kind: 'negative', test: /\bnegative\b/i, positional: true },
  { kind: 'zero', test: /\bof\s+`?0`?(?![\w.])|\bzero\s+step\b|\bstep\s+`?0`?(?![\w.])/i, positional: true },
  { kind: 'multibyte', test: /\bunicode\b|\brunes?\b|\bmulti-?byte\b|\bnon-ascii\b|\butf-?8\b/i, positional: false },
  { kind: 'empty-selection', test: EMPTY_SELECTION, positional: false },
];

function enumeratedDomains(sentences: RequestSentence[], family: SyntaxFamily | null): CoverageRequirement[] {
  const names = family?.names ?? [];
  const out: CoverageRequirement[] = [];
  let previous: { kinds: typeof SENTENCE_KINDS; section: number } | null = null;
  for (const sentence of sentences) {
    let kinds = SENTENCE_KINDS.filter(entry => entry.test.test(sentence.text));
    if (!kinds.length && previous && previous.section === sentence.section && /^(?:this|these|that|it)\s+(?:also\s+)?(?:includes?|applies|covers?)\b/i.test(sentence.text)) kinds = previous.kinds;
    previous = kinds.length ? { kinds, section: sentence.section } : previous && previous.section === sentence.section ? previous : null;
    if (!kinds.length) continue;
    const op = /\bassign/i.test(sentence.text) ? 'write' : sectionOp(sentence.heading);
    if (op === 'parse') continue;
    const positions = names.length ? listNames(sentence.text.replace(/`/g, ''), names) : [];
    const receivers = (['array', 'string'] as const).filter(receiver => new RegExp(`\\b${receiver}s?\\b`, 'i').test(sentence.text));
    const shapes: Shape[] = [];
    if (/\bsingle[- ]index\b/i.test(sentence.text)) shapes.push('index');
    if (/\btwo-part\b/i.test(sentence.text)) shapes.push('range2');
    if (/\bthree-part\b/i.test(sentence.text)) shapes.push('range3');
    for (const entry of kinds) {
      // A positional class needs the operand it names ("A step of `0`", "Non-numeric `end` or `step`").
      const classSets: string[][] = entry.positional ? positions.map(position => [`${entry.kind}:${position}`]) : [[entry.kind]];
      if (!classSets.length) continue;
      // A flat class (runes, zero-length) needs an enumeration to spread over: forms, or two or more
      // receivers ("reversed by rune" alone names no domain; the write mirror covers single-receiver sentences).
      if (!entry.positional && !shapes.length && receivers.length < 2) continue;
      const receiverList: Array<Receiver | undefined> = entry.kind === 'multibyte' ? [undefined] : receivers.length >= 2 ? [...receivers] : receivers.length === 1 ? [receivers[0]] : [undefined];
      const shapeList: Array<Shape | undefined> = shapes.length ? shapes : [undefined];
      for (const classes of classSets) {
        for (const receiver of receiverList) {
          for (const shape of shapeList) {
            out.push(requirement('enumerated-domain', { op, classes, ...(receiver ? { receiver } : {}), ...(shape ? { shape } : {}) }, [sentence.text]));
          }
        }
        // Omitted and explicit null are different inputs: a non-numeric operand that can be omitted needs a null row.
        const position = classes[0]!.split(':')[1];
        if (entry.kind === 'nonnumeric' && family?.omittable && position && names.includes(position)) {
          out.push(requirement('enumerated-domain', { op, classes: [`null:${position}`] }, [sentence.text]));
        }
      }
    }
  }
  return out;
}

/** Merge identical requirements (union of sentences) and drop one implied by another. */
function consolidate(requirements: CoverageRequirement[]): CoverageRequirement[] {
  const byKey = new Map<string, CoverageRequirement>();
  for (const entry of requirements) {
    const seen = byKey.get(entry.key);
    if (seen) seen.sentences = [...new Set([...seen.sentences, ...entry.sentences])];
    else byKey.set(entry.key, { ...entry, sentences: [...entry.sentences] });
  }
  const all = [...byKey.values()];
  return all.filter(entry => !all.some(other => other !== entry && other.key !== entry.key && implies(other, entry)
    && (other.sentences.push(...entry.sentences.filter(sentence => !other.sentences.includes(sentence))), true)));
}


/** Every row the request patterns require, with the intents that state it (empty = missing) and an excludes entry naming it. */
export function planCoverageStatus(items: readonly CheckedItem[], requestText: string): CoverageStatus[] {
  const family = requestSyntaxFamily(requestText);
  const sentences = requestSentences(requestText);
  const rows = checklistRows(items, family);
  const demanded = [...omitCombinations(requestText, family, sentences), ...enumeratedDomains(sentences, family)];
  const requirements = consolidate([...writeMirror(rows, sentences, demanded, family), ...demanded]);
  const excludes = items.filter(item => item.status !== 'withdrawn').flatMap(item => (item.excludes ?? []).map(text => ({ itemId: item.id, text })));
  return requirements.map(entry => ({
    requirement: entry,
    satisfiedBy: rows.filter(row => satisfies(row, entry)).map(row => row.ref),
    excludedBy: excludes.find(row => squashLower(row.text).includes(squashLower(entry.key)))?.itemId ?? null,
  }));
}

function exampleFor(entry: CoverageRequirement, family: SyntaxFamily | null): string {
  const names = family?.names ?? ['start', 'end', 'step'];
  const parts = names.map(name => name);
  for (const value of entry.classes) {
    const [kind, position] = value.split(':');
    const at = position ? names.indexOf(position) : -1;
    if (at < 0) continue;
    parts[at] = kind === 'omitted' ? '' : kind === 'null' ? 'null' : kind === 'zero' ? '0' : kind === 'negative' ? '-1' : kind === 'nonnumeric' ? '{}' : parts[at]!;
  }
  let shape = entry.pattern ?? `[${parts.join(':')}]`;
  if (entry.shape === 'index') shape = '[i]';
  else if (entry.shape === 'range2') shape = `[${parts.slice(0, 2).join(':')}]`;
  const target = entry.receiver === 'string' || entry.classes.includes('multibyte') ? 's' : entry.receiver === 'array' ? 'a' : 'x';
  const text = entry.classes.includes('multibyte') ? ' with non-ASCII text (e.g. é)' : entry.classes.includes('empty-selection') ? ' selecting zero indexes' : '';
  return entry.op === 'write' ? `${target}${shape} = <value>${text}` : `${target}${shape}${text}`;
}

/** Most similar item for a missing row: most rows of its op (and receiver), ties to the first. */
function targetItem(entry: CoverageRequirement, rows: RowFeatures[], itemIds: string[]): string {
  const score = (itemId: string): number => rows.filter(row => row.itemId === itemId
    && (entry.op === 'eval' ? row.op === 'read' || row.op === 'write' : row.op === entry.op)
    && (!entry.receiver || row.receivers.has(entry.receiver))
    && (!entry.pattern || row.patterns.size > 0)).length;
  let best = itemIds[0]!;
  for (const itemId of itemIds) if (score(itemId) > score(best)) best = itemId;
  return best;
}

/** The missing, unexcluded rows, each with the item its placeholder goes to. */
export function planCoverageGaps(items: readonly CheckedItem[], requestText: string): CoverageGap[] {
  const open = items.filter(item => item.status !== 'withdrawn');
  if (!open.length) return [];
  const family = requestSyntaxFamily(requestText);
  const rows = checklistRows(open, family);
  return planCoverageStatus(open, requestText)
    .filter(status => status.satisfiedBy.length === 0 && status.excludedBy === null)
    .map(status => ({ ...status.requirement, itemId: targetItem(status.requirement, rows, open.map(item => item.id)), example: exampleFor(status.requirement, family) }));
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One line per gap (story_review message, next Why). */
export function describeCoverageGap(gap: CoverageGap): string {
  return `${gap.key} (e.g. ${gap.example}; request: "${clip(gap.sentences[0] ?? '', 160)}"${gap.sentences.length > 1 ? ` +${gap.sentences.length - 1}` : ''})`;
}

export interface CoveragePlaceholder { desc: string; derivation: VerificationIntentDerivation; keys: string[] }

/**
 * The placeholder intents next's plan_authoring adds to one item: one per
 * rule, listing its missing rows (the owner may split it into one intent per
 * case). The triggering request sentence is already the requestQuote.
 */
export function coveragePlaceholders(gaps: readonly CoverageGap[], itemId: string): CoveragePlaceholder[] {
  const mine = gaps.filter(gap => gap.itemId === itemId);
  const rules = [...new Set(mine.map(gap => gap.rule))];
  return rules.map(rule => {
    const group = mine.filter(gap => gap.rule === rule);
    return {
      desc: `<${rule}: one input -> exact result or exact error (never a crash) per case, written in the request's syntax: ${group.map(gap => `${gap.key.replace(`${COVERAGE_GAP_PREFIX} `, '')} (e.g. ${gap.example})`).join('; ')}>`,
      derivation: {
        requestQuote: group[0]!.sentences[0] ?? '<the request.md sentence these rows follow from, quoted verbatim>',
        computation: '<the steps from that sentence to each expected value; drop the derivation if request.md quotes every expected value>',
      },
      keys: group.map(gap => gap.key),
    };
  });
}

/**
 * Scope-plan reviewer rule: the judgment form of the three checks (requests
 * the deterministic patterns do not match), plus any mechanical row still
 * missing.
 */
export function renderCoverageMatrixRule(items: readonly CheckedItem[], requestText: string): string[] {
  const gaps = planCoverageGaps(items, requestText);
  return [
    `Coverage matrix (blocking): (1) when the request makes one operation follow another's semantics (e.g. assignment uses read selection), every value class an intent tests on one side (omitted, explicit null, 0, negative, non-numeric/wrong type, multibyte, empty selection) needs an intent on the other; (2) a syntax with optional parts needs an intent per omission pattern; (3) each member of an enumerated list in the request (operand positions, receiver types, forms, error messages, examples) x the property its sentence states needs an intent. Missing: {"feature":"${COVERAGE_GAP_PREFIX} <what>: <request sentence>","status":"gap","source":"request.md"}.`,
    gaps.length
      ? `Mechanical coverage rows still missing (each a gap unless an excludes entry names it): ${gaps.slice(0, 12).map(gap => gap.key).join('; ')}${gaps.length > 12 ? ` +${gaps.length - 12} more` : ''}.`
      : 'Mechanical coverage rows: all present.',
  ];
}
