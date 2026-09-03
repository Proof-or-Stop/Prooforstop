#!/usr/bin/env node
/**
 * B-97df CHK-004: runnable LLM usage-ledger reporter task (NOT a CLI command).
 *
 * Reads a ledger JSONL file (CLI arg or env), an OPTIONAL price-table JSON file,
 * builds the read-only diagnostics report from the usage-ledger module, and
 * prints it human-readably or as JSON (`--json`).
 *
 * This is deliberately a TASK, not a registered `proof-or-stop` CLI command: it does
 * not touch cli-engine / handlers / the command registry, honoring the
 * no-other-logic constraint. It only consumes the in-module diagnostics layer.
 *
 * Usage:
 *   node dist/tasks/usage-ledger-report.js <ledger.jsonl> [price-table.json] [--json]
 *   PROOF_OR_STOP_USAGE_LEDGER_PATH=... PROOF_OR_STOP_USAGE_PRICE_TABLE=... node ... [--json]
 *
 * Exit codes:
 *   0  report printed (including a valid empty report for a 0-record ledger)
 *   1  bad usage / missing ledger / corrupt JSONL / invalid price table
 */

import { existsSync, readFileSync } from 'node:fs';

import { buildUsageReport } from '../core/usage-ledger/diagnostics.js';
import type { PriceTable, UsageReport } from '../core/usage-ledger/diagnostics.js';
import { parseLedgerLines } from '../core/usage-ledger/summary.js';

interface CliArgs {
  ledgerPath: string | null;
  priceTablePath: string | null;
  json: boolean;
}

/** Parse argv + env into resolved inputs. Flags may appear in any position. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliArgs {
  const positionals: string[] = [];
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  const ledgerPath = positionals[0] ?? env.PROOF_OR_STOP_USAGE_LEDGER_PATH ?? null;
  const priceTablePath = positionals[1] ?? env.PROOF_OR_STOP_USAGE_PRICE_TABLE ?? null;
  return { ledgerPath, priceTablePath, json };
}

/**
 * Load and minimally validate an injected price table. Throws (not falls back)
 * on a malformed table so a typo never silently produces missing-cost output.
 */
export function loadPriceTable(path: string): PriceTable {
  if (!existsSync(path)) {
    throw new Error(`price-table file not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`price-table file is not valid JSON: ${path}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('price-table must be a JSON object');
  }
  const table = parsed as Record<string, unknown>;
  if (typeof table.pricingRef !== 'string' || table.pricingRef.length === 0) {
    throw new Error('price-table.pricingRef must be a non-empty string');
  }
  if (typeof table.pricingVersion !== 'string' || table.pricingVersion.length === 0) {
    throw new Error('price-table.pricingVersion must be a non-empty string');
  }
  if (typeof table.rates !== 'object' || table.rates === null) {
    throw new Error('price-table.rates must be an object of model -> rates');
  }
  return table as unknown as PriceTable;
}

/** Render the report as a deterministic, human-readable string. */
export function renderHuman(report: UsageReport): string {
  const lines: string[] = [];
  lines.push('LLM Usage Ledger Report (read-only diagnostics)');
  lines.push(`  records parsed:   ${report.recordCount}`);
  lines.push(`  records selected: ${report.selectedCount}`);
  if (report.pricing) {
    lines.push(`  pricing:          ${report.pricing.pricingRef} (${report.pricing.pricingVersion})`);
  } else {
    lines.push('  pricing:          (none injected — costs omitted)');
  }
  lines.push('');
  lines.push('Overall by source:');
  for (const source of ['provider-reported', 'prompt-size-estimate', 'unavailable'] as const) {
    const s = report.overall.bySource[source];
    const count = report.overall.counts[source];
    lines.push(
      `  ${source.padEnd(20)} count=${count} known=${s.knownCount} unknown=${s.unknownCount} ` +
        `primary[in=${s.primaryKnown.input} out=${s.primaryKnown.output}] ` +
        `tokens[in=${s.known.input} out=${s.known.output} ` +
        `cacheCreate=${s.known.cacheCreation} cacheRead=${s.known.cacheRead}]`,
    );
  }
  lines.push(`  unknown records (all sources): ${report.overall.unknownCount}`);
  lines.push('');
  lines.push(`Groups (${report.groups.length}):`);
  for (const g of report.groups) {
    const story = g.key.storyId === null ? '(no-story)' : g.key.storyId;
    lines.push(
      `  - story=${story} phase=${g.key.phase} role=${g.key.agentType} ` +
        `model=${g.key.model} provider=${g.key.provider} ` +
        `records=${g.recordCount} unknown=${g.unknownCount}`,
    );
    for (const source of ['provider-reported', 'prompt-size-estimate', 'unavailable'] as const) {
      const s = g.bySource[source];
      if (s.knownCount === 0 && s.unknownCount === 0) continue;
      let costStr = '';
      if (s.cost) {
        costStr = s.cost.unknown
          ? ` cost=unknown(${s.cost.reason})`
          : ` cost=$${s.cost.amount.toFixed(6)}`;
      }
      lines.push(
        `      ${source.padEnd(20)} known=${s.knownCount} unknown=${s.unknownCount} ` +
          `primary[in=${s.primaryKnown.input} out=${s.primaryKnown.output}] ` +
          `tokens[in=${s.known.input} out=${s.known.output} ` +
          `cacheCreate=${s.known.cacheCreation} cacheRead=${s.known.cacheRead}]${costStr}`,
      );
    }
  }
  return lines.join('\n');
}

/** Build the report from resolved inputs. Throws on missing/corrupt ledger. */
export function runReport(args: CliArgs): UsageReport {
  if (!args.ledgerPath) {
    throw new Error(
      'usage: usage-ledger-report <ledger.jsonl> [price-table.json] [--json] ' +
        '(or set PROOF_OR_STOP_USAGE_LEDGER_PATH)',
    );
  }
  if (!existsSync(args.ledgerPath)) {
    throw new Error(`ledger file not found: ${args.ledgerPath}`);
  }
  const priceTable = args.priceTablePath ? loadPriceTable(args.priceTablePath) : null;
  // parseLedgerLines throws on a non-JSON line — a corrupt ledger must surface,
  // not silently produce partial output.
  const records = parseLedgerLines(readFileSync(args.ledgerPath, 'utf8'));
  return buildUsageReport(records, { priceTable });
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`usage-ledger-report: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  let report: UsageReport;
  try {
    report = runReport(args);
  } catch (err) {
    console.error(`usage-ledger-report: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderHuman(report));
  }
}

// Only run when executed directly (so the smoke can import the helpers above).
const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('usage-ledger-report.js') || invokedPath.endsWith('usage-ledger-report.ts')) {
  main();
}
