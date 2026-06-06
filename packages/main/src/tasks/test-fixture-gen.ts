
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { scan } from './extract.js';
import { loadConfig } from '../core/config.js';
import type { TaskAnnotation } from './types.js';

/** Generation result */
export interface FixtureGenResult {
  generated: Array<{ functionName: string; fixturePath: string }>;
  skipped: Array<{ functionName: string; reason: string }>;
}

export function inferDefaultValue(signature: string): unknown {
  // Extract parameter list from signature
  const paramMatch = signature.match(/\(([^)]*)\)/);
  if (!paramMatch || !paramMatch[1].trim()) return {};

  const params = paramMatch[1];

  // Simple type inference from parameter names and types
  const result: Record<string, unknown> = {};
  const parts = params.split(',').map(p => p.trim());

  for (const part of parts) {
    // Match "name: type" or "name?: type" or just "name"
    const match = part.match(/^(\w+)\??\s*:\s*(.+)$/);
    if (!match) continue;
    const [, name, type] = match;
    const cleanType = type.trim().replace(/;$/, '');

    if (cleanType === 'string') result[name] = `test-${name}`;
    else if (cleanType === 'number') result[name] = 1;
    else if (cleanType === 'boolean') result[name] = true;
    else if (cleanType.startsWith('Array') || cleanType.endsWith('[]')) result[name] = [];
    else if (cleanType.includes('string')) result[name] = `test-${name}`;
    else if (cleanType.includes('number')) result[name] = 1;
    else result[name] = {};
  }

  return result;
}

export function generateFixtureTemplate(
  task: TaskAnnotation,
): { path: string; content: string } | null {
  if (!task.test || !task.functionName) return null;

  const defaultInput = task.functionSignature
    ? inferDefaultValue(task.functionSignature)
    : {};

  const fixture = {
    cases: [
      {
        name: `${task.functionName} - normal call`,
        input: defaultInput,
        expect: {},
      },
      {
        name: `${task.functionName} - edge case`,
        input: defaultInput,
        expect: {},
      },
    ],
  };

  return {
    path: task.test,
    content: JSON.stringify(fixture, null, 2),
  };
}

export function generateMissingFixtures(
  projectRoot: string,
  scanRoot: string,
): FixtureGenResult {
  const tasks = scan(scanRoot);
  const result: FixtureGenResult = { generated: [], skipped: [] };

  for (const t of tasks) {
    if (!t.test || !t.functionName) continue;

    const fixturePath = join(projectRoot, loadConfig(projectRoot).fixturesDir, t.test + '.json');

    if (existsSync(fixturePath)) {
      result.skipped.push({
        functionName: t.functionName,
        reason: 'fixture already exists',
      });
      continue;
    }

    const template = generateFixtureTemplate(t);
    if (!template) {
      result.skipped.push({
        functionName: t.functionName,
        reason: 'cannot generate template (missing @test or functionName)',
      });
      continue;
    }

    // Ensure directory exists
    const dir = dirname(fixturePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(fixturePath, template.content + '\n', 'utf-8');
    result.generated.push({
      functionName: t.functionName,
      fixturePath: `tests/fixtures/${t.test}.json`,
    });
  }

  return result;
}
