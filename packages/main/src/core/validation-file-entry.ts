import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readBrandEnv } from './brand-env.js';

export function findValidateFile(projectRoot: string): string | null {
  return ['validate.ts', 'validate.js', 'validate.mts']
    .find(file => existsSync(join(projectRoot, file))) ?? null;
}

export function validateFileDefaultTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = Number(readBrandEnv('VALIDATE_FILE_TIMEOUT_MS', env));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}
