/**
 * Old-PoS run 31 (D3): R1's repair "closed" F-001 by adding a code test while
 * the cited checklist.json line still stated the wrong literal; R2 reported it four more
 * times and REM2 cost 23 minutes. finding_resolve now refuses a resolution
 * whose cited material did not change:
 *   - cited Story-metadata text (checklist userSees / intent rows) must be
 *     corrected (the same verification as a metadata correction); no code test
 *     covers checklist text;
 *   - cited product files: at least one changed since the reviewed head, or a
 *     test file changed (a test-gap finding is closed by a test).
 * Dispositions (pre-existing out of scope) and duplicate coverage runs keep
 * their own evidence and are not checked here.
 */
import { execFileSync } from 'node:child_process';
import type { Finding } from './types.js';
import { isStoryMetadataFile, isTestFile } from './metadata-finding-class.js';
import { describeMetadataCorrection, findingCitesStoryMetadata, isMetadataTargetFinding, metadataCorrectionCleared, storedFindingCorrections } from './metadata-correction.js';

export const FINDING_RESOLUTION_UNCHANGED_CITATION = 'finding_resolution_unchanged_citation';

type Store = Parameters<typeof storedFindingCorrections>[0]['store'];

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).trim(); } catch { return null; }
}

/** The head the finding was judged on: its managed binding, else the last commit before it was recorded. */
function judgedHead(gitCwd: string, finding: Finding): string | null {
  const bound = finding.managedEvidenceBinding?.headHash?.trim();
  if (bound && git(gitCwd, ['cat-file', '-e', `${bound}^{commit}`]) !== null) return bound;
  if (!finding.createdAt) return null;
  return git(gitCwd, ['log', '-1', '--format=%H', `--before=${finding.createdAt}`, 'HEAD']) || null;
}

/** The refusal text when the finding's cited material is unchanged, else null. */
export function resolutionCitationRefusal(args: { store: Store; storyId: string; gitCwd: string; finding: Finding }): string | null {
  const { finding, storyId } = args;
  if (findingCitesStoryMetadata(finding)) {
    const items = args.store.readChecklist(storyId).items;
    const open = storedFindingCorrections(args).filter(row => !metadataCorrectionCleared(items.find(item => item.id === row.itemId), row));
    if (open.length) {
      const first = open[0]!;
      const payload = { storyId, itemId: first.itemId, ...(first.field === 'userSees' ? { userSees: '<corrected userSees>' } : { verificationIntent: '<complete corrected verificationIntent JSON>' }),
        reason: '<the request sentence and the value it implies>', metadataCorrection: true };
      return `finding_resolve refused: ${finding.id} cites Story-metadata text that is unchanged: ${open.map(describeMetadataCorrection).join('; ')}. `
        + `A code test does not correct checklist text (old-PoS run 31 F-001) [${FINDING_RESOLUTION_UNCHANGED_CITATION}]\n`
        + `Next: proof-or-stop checklist_update '${JSON.stringify(payload)}'`;
    }
    // Old-PoS run 33 (F-003): a metadata finding by correction target cites product files only as
    // corroboration (the code was right); its corrected checklist text is the whole resolution.
    if (isMetadataTargetFinding(args)) return null;
  }
  const cited = (finding.files ?? []).filter(path => path.trim() && !isStoryMetadataFile(path));
  if (cited.length === 0) return null;
  const head = judgedHead(args.gitCwd, finding);
  if (!head) return null;
  const diff = git(args.gitCwd, ['diff', '--name-only', head]);
  if (diff === null) return null;
  const changed = new Set(diff.split('\n').map(row => row.trim()).filter(Boolean));
  for (const row of (git(args.gitCwd, ['ls-files', '--others', '--exclude-standard']) ?? '').split('\n')) if (row.trim()) changed.add(row.trim());
  if (cited.some(path => changed.has(path))) return null;
  if ([...changed].some(path => isTestFile(path) && !isStoryMetadataFile(path))) return null;
  return `finding_resolve refused: ${finding.id} cites ${cited.join(', ')}, unchanged since the reviewed head ${head.slice(0, 12)}, and no test file changed; a resolution needs the repair (or the test that covers it) [${FINDING_RESOLUTION_UNCHANGED_CITATION}]\n`
    + `Next: proof-or-stop next --storyId=${storyId}`;
}
