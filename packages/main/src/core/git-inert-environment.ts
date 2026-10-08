/**
 * Whether the process environment could redirect or reshape a read-only git
 * probe (repository, object store, config). The process-local git memos
 * (git-ref-witness-memo, git-object-read-memo, story-git-bytes) run git every
 * time when it could.
 *
 * Inert: interactive/identity variables (editor, pager, prompting, author and
 * committer identity), and config passed through GIT_CONFIG_COUNT /
 * GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> when every key is a credential or
 * commit-identity setting. N9 (lab owner-init-and-worker-prompt): agent hosts
 * set `credential.interactive=false` / `credential.guiPrompt=false` this way
 * for every shell, which bypassed all three memos for every gate command
 * (harness story_advance DONE 1016 instead of ~250 child processes).
 */
const INERT_GIT_ENV = new Set([
  'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
]);
const CONFIG_ENV = /^GIT_CONFIG_(?:COUNT|KEY_(\d+)|VALUE_(\d+))$/;
const INERT_CONFIG_KEY = /^(?:credential\.[A-Za-z0-9.*:/_-]+|user\.(?:name|email))$/i;

function inertConfigEnvironment(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  const count = Number(env.GIT_CONFIG_COUNT);
  if (!Number.isInteger(count) || count < 0 || count > 64) return false;
  for (const key of keys) {
    const match = key.match(CONFIG_ENV)!;
    const index = match[1] ?? match[2];
    if (index !== undefined && Number(index) >= count) return false;
  }
  for (let i = 0; i < count; i += 1) {
    if (!INERT_CONFIG_KEY.test(env[`GIT_CONFIG_KEY_${i}`] ?? '')) return false;
  }
  return true;
}

export function gitEnvironmentRedirected(env: NodeJS.ProcessEnv = process.env): boolean {
  const live = Object.keys(env).filter(key => key.startsWith('GIT_') && !INERT_GIT_ENV.has(key) && env[key] !== undefined);
  if (live.length === 0) return false;
  if (!live.every(key => CONFIG_ENV.test(key))) return true;
  return !inertConfigEnvironment(env, live);
}
