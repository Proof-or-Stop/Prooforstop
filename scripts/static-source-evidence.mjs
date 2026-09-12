import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');

function snapshot(root, file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || path.isAbsolute(file)
      || /^[A-Za-z]:/.test(file) || file.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error('source evidence file must be a normalized repository-relative path');
  }
  const base = fs.realpathSync(root), target = fs.realpathSync(path.join(base, file));
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('source evidence file escapes the repository');
  }
  const text = fs.readFileSync(target, 'utf8');
  return { text, sourceDigest: hash(text), lines: text.split('\n') };
}

function excerptFrom(source, startLine, endLine) {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
      || startLine < 1 || endLine < startLine || endLine > source.lines.length) {
    throw new Error('source evidence line bounds are invalid');
  }
  return source.lines.slice(startLine - 1, endLine).join('\n');
}

/** Generate all fields together from one read. This does not approve the rationale. */
export function createStaticSourceEvidence(root, file, startLine, endLine) {
  const source = snapshot(root, file);
  return { file, startLine, endLine, sourceDigest: source.sourceDigest,
    excerpt: excerptFrom(source, startLine, endLine) };
}

/** Historical notes never count as current evidence. Every current excerpt must match. */
export function staticSourceEvidenceError(root, evidence, callsite) {
  if (!Array.isArray(evidence) || evidence.length === 0) return 'source evidence missing';
  let covered = false;
  const snapshots = new Map();
  try {
    for (const item of evidence) {
      if (typeof item === 'string') continue; // Supplemental narrative, never authority.
      if (!item || typeof item !== 'object' || Array.isArray(item)) return 'source evidence malformed';
      if (item.historical === true) continue;
      if (item.historical !== undefined && item.historical !== false) return 'source evidence historical flag malformed';
      if (!snapshots.has(item.file)) snapshots.set(item.file, snapshot(root, item.file));
      const source = snapshots.get(item.file);
      if (item.sourceDigest !== source.sourceDigest) return 'source evidence digest is stale';
      if (item.excerpt !== excerptFrom(source, item.startLine, item.endLine)) return 'source evidence excerpt does not match its lines';
      if (item.file === callsite.file && item.startLine <= callsite.line && item.endLine >= callsite.line) covered = true;
    }
  } catch (error) {
    return 'source evidence invalid: ' + error.message;
  }
  return covered ? null : 'source evidence does not cover the current callsite';
}
