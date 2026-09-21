import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';

import { dirname, isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';








import { LEGACY_WORD, LEGACY_TITLE, LEGACY_UPPER, RETIRED_PRODUCT_NAME, ALLOWED_CLASSES } from "./rules.mjs";
import { EXPECTED_EXACT_ALLOWLIST_COUNT } from "./scanner-contexts.mjs";
import { FROZEN_SALTS } from "./provenance-data.mjs";

export const scriptDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const initialCwd = resolve(scriptDir, '..');

export let gitExecutable = null;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function gitCandidates() {
  const bundled = resolve(dirname(process.execPath), '../../bin/fallback/git');
  return [...new Set([
    process.env.PROOF_OR_STOP_GIT,
    'git',
    bundled,
    '/usr/bin/git',
  ].filter(Boolean))];
}

export function selectGit(cwd = initialCwd) {
  if (gitExecutable) return gitExecutable;
  const failures = [];
  for (const candidate of gitCandidates()) {
    try {
      const top = execFileSync(candidate, ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (top) {
        gitExecutable = candidate;
        return candidate;
      }
    } catch (error) {
      failures.push(`${candidate}: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    }
  }
  throw new Error(`tracked-file enumeration requires Git; candidates failed: ${failures.join(' | ')}`);
}

export function git(args, options = {}) {
  const cwd = options.cwd || initialCwd;
  return execFileSync(selectGit(cwd), ['-C', cwd, ...args], {
    encoding: options.encoding === null ? null : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function repoRoot() {
  return git(['rev-parse', '--show-toplevel']).trim();
}

export function trackedFiles(root) {
  const output = git(['ls-files', '-z'], { cwd: root });
  const files = [...new Set(output.split('\0').filter(Boolean))].sort();
  if (files.length === 0) throw new Error('tracked-file enumeration returned zero files');
  return files;
}

export function readTrackedText(root, path) {
  const absolute = resolve(root, path);
  return lstatSync(absolute).isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute, 'utf8');
}

export function countLiteral(text, token) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(token, offset)) !== -1) {
    count += 1;
    offset += token.length;
  }
  return count;
}

export function occurrenceContextDigest(text, token) {
  const lines = text.split(/\r?\n/).filter((line) => line.includes(token));
  return sha256(lines.join('\n'));
}

export function hasBroadToken(token) {
  return new Set([
    LEGACY_WORD,
    LEGACY_TITLE,
    LEGACY_UPPER,
    `${LEGACY_UPPER}_`,
    `@${LEGACY_WORD}/`,
    `.${LEGACY_WORD}`,
    RETIRED_PRODUCT_NAME,
    'Proofbound',
    'PROOFBOUND',
    'PROOFBOUND_',
    '@proofbound/',
    '.proofbound',
    `${RETIRED_PRODUCT_NAME}-`,
    `${RETIRED_PRODUCT_NAME}.`,
  ]).has(token);
}

export function validateExactRows(rows, tracked, root, readText = (path) => readFileSync(resolve(root, path), 'utf8')) {
  const errors = [];
  if (rows.length !== EXPECTED_EXACT_ALLOWLIST_COUNT) {
    errors.push(`allowlist row count ${rows.length}, expected ${EXPECTED_EXACT_ALLOWLIST_COUNT}`);
  }
  const ids = new Set();
  const rowKeys = new Set();
  const signatureCoverage = new Map(FROZEN_SALTS.map((salt) => [salt, 0]));
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      errors.push('allowlist row is not an object');
      continue;
    }
    if (!row.id || ids.has(row.id)) errors.push(`allowlist duplicate/missing id: ${row.id || '<missing>'}`);
    ids.add(row.id);
    if (!ALLOWED_CLASSES.has(row.class)) errors.push(`allowlist ${row.id}: unknown class ${row.class}`);
    if (row.disposition !== 'frozen') errors.push(`allowlist ${row.id}: disposition must be frozen`);
    if (!row.reason || row.reason.length < 12) errors.push(`allowlist ${row.id}: reason is missing or too broad`);
    if (!row.path || isAbsolute(row.path) || row.path.includes('..') || /[*?\[\]{}]/u.test(row.path)) {
      errors.push(`allowlist ${row.id}: path must be one exact repository-relative file`);
    } else if (!tracked.has(row.path)) {
      errors.push(`allowlist ${row.id}: stale/missing tracked path ${row.path}`);
    } else if (statSync(resolve(root, row.path)).isDirectory()) {
      errors.push(`allowlist ${row.id}: directory exemptions are forbidden`);
    }
    if (!row.token || hasBroadToken(row.token) || /[*?\[\]{}]/u.test(row.token)) {
      errors.push(`allowlist ${row.id}: token is empty, wildcarded, or a forbidden broad identity`);
    }
    if (!Number.isInteger(row.expectedOccurrences) || row.expectedOccurrences <= 0) {
      errors.push(`allowlist ${row.id}: expectedOccurrences must be a positive exact integer`);
    }
    if (!/^[a-f0-9]{64}$/u.test(row.contextSha256 || '')) {
      errors.push(`allowlist ${row.id}: contextSha256 must be exact sha256`);
    }
    if (!row.verificationCommand || !row.expectedVerification) {
      errors.push(`allowlist ${row.id}: verification command/result is required`);
    }
    const key = `${row.path}\0${row.token}`;
    if (rowKeys.has(key)) errors.push(`allowlist ${row.id}: duplicate path+token row`);
    rowKeys.add(key);
    if (!tracked.has(row.path)) continue;
    const text = readText(row.path);
    const actualCount = countLiteral(text, row.token);
    if (actualCount !== row.expectedOccurrences) {
      errors.push(`allowlist ${row.id}: occurrence count ${actualCount}, expected ${row.expectedOccurrences}`);
    }
    const actualContext = occurrenceContextDigest(text, row.token);
    if (actualContext !== row.contextSha256) {
      errors.push(`allowlist ${row.id}: bounded context digest changed (${actualContext})`);
    }
    if (signatureCoverage.has(row.token)) {
      signatureCoverage.set(row.token, signatureCoverage.get(row.token) + actualCount);
    }
  }
  for (const [salt, count] of signatureCoverage) {
    if (count === 0) errors.push(`missing signature allowlist source row for ${salt}`);
  }
  return errors;
}
