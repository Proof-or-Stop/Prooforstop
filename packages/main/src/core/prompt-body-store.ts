/** Immutable exact prompt bytes. Metadata readers carry references; authority consumers hydrate explicitly. */
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { domainSeparatedDigest } from './prompt-contracts.js';
import type { ReviewRun } from './types.js';

export const PROMPT_BODY_DIRECTORY = 'prompt-bodies';
export function isPromptBodyArtifactPath(path: string): boolean {
  return /^prompt-bodies\/[a-f0-9]{64}\.txt$/.test(path);
}
function bodyPath(storyDir: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('prompt body reference is malformed');
  const directory = join(storyDir, PROMPT_BODY_DIRECTORY);
  if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) {
    throw new Error('prompt body directory must be a real directory');
  }
  return join(directory, `${digest}.txt`);
}
export function readPromptBody(storyDir: string, digest: string): string {
  const path = bodyPath(storyDir, digest);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    if (!fstatSync(fd).isFile()) throw new Error('prompt body must be a regular file');
    bytes = readFileSync(fd);
  } finally { closeSync(fd); }
  const body = bytes.toString('utf8');
  if (!Buffer.from(body, 'utf8').equals(bytes)) throw new Error('prompt body is not exact UTF-8');
  if (domainSeparatedDigest('assembled-prompt.raw-utf8.v1', body) !== digest) throw new Error('prompt body content digest mismatch');
  return body;
}
export function writePromptBody(storyDir: string, body: string, digest: string): string {
  if (domainSeparatedDigest('assembled-prompt.raw-utf8.v1', body) !== digest) throw new Error('prompt body publication digest mismatch');
  const path = bodyPath(storyDir, digest);
  mkdirSync(join(storyDir, PROMPT_BODY_DIRECTORY), { recursive: true });
  if (existsSync(path)) {
    if (readPromptBody(storyDir, digest) !== body) throw new Error('prompt body immutable conflict');
    return digest;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, body, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    // An exclusive hard-link publishes complete bytes without replacing an existing object.
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (readPromptBody(storyDir, digest) !== body) throw new Error('prompt body immutable conflict');
  } finally { unlinkSync(temporary); }
  return digest;
}
export function readReviewPromptBody(storyDir: string, run: ReviewRun): string | undefined {
  if (run.assembledPromptRef !== undefined) {
    if (!run.envelopeId || run.assembledPrompt !== undefined || run.assembledPromptRef !== run.promptHash) {
      throw new Error('review run prompt reference conflicts with its signed identity');
    }
    return readPromptBody(storyDir, run.assembledPromptRef);
  }
  // Bounded compatibility read; old signed records are never rewritten during reads.
  return run.assembledPrompt;
}
