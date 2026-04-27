import { execFileSync } from 'child_process';
import { createHash } from 'crypto';

export type EvidenceFreshness = {
  fresh: boolean;
  reason: string;
  currentHead?: string;
  changedFiles: string[];
  materialFiles: string[];
};

function headMatches(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export function isStoryMetadataPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return [
    'docs/story/',
    '.koala/story/',
    'docs/koala/framework-audit/',
  ].some(prefix => normalized.startsWith(prefix));
}

export function currentGitHead(projectRoot: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

export function changedFilesBetween(projectRoot: string, fromHead: string, toHead = 'HEAD'): string[] {
  const raw = execFileSync('git', ['diff', '--name-only', `${fromHead}..${toHead}`], {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return raw.split('\n').map(line => line.trim()).filter(Boolean);
}

export function currentMaterialHash(projectRoot: string, ref = 'HEAD'): string | undefined {
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '-z', ref], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const entries = raw.split('\0').filter(Boolean);
    const materialEntries: string[] = [];
    for (const entry of entries) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const meta = entry.slice(0, tab);
      const filePath = entry.slice(tab + 1);
      if (isStoryMetadataPath(filePath)) continue;
      const objectId = meta.trim().split(/\s+/)[2];
      if (!objectId) continue;
      materialEntries.push(`${filePath}\0${objectId}`);
    }
    materialEntries.sort();
    return createHash('sha256').update(materialEntries.join('\0')).digest('hex');
  } catch {
    return undefined;
  }
}

export function checkEvidenceFreshnessForGit(
  projectRoot: string,
  evidenceHash: string | undefined,
  evidenceMaterialHash?: string,
): EvidenceFreshness {
  if (!evidenceHash) {
    return {
      fresh: true,
      reason: 'evidence 无 headHash（旧格式，跳过新鲜度检查）',
      changedFiles: [],
      materialFiles: [],
    };
  }

  const currentHead = currentGitHead(projectRoot);
  if (!currentHead) {
    return {
      fresh: true,
      reason: '无法获取 git HEAD，跳过新鲜度检查',
      changedFiles: [],
      materialFiles: [],
    };
  }

  if (evidenceMaterialHash) {
    const materialHash = currentMaterialHash(projectRoot);
    if (materialHash) {
      if (materialHash === evidenceMaterialHash) {
        return {
          fresh: true,
          reason: 'evidence materialHash 对应当前实体文件状态',
          currentHead,
          changedFiles: [],
          materialFiles: [],
        };
      }
      return {
        fresh: false,
        reason: `evidence materialHash 与当前实体文件状态不匹配`,
        currentHead,
        changedFiles: [],
        materialFiles: ['<material-tree-changed>'],
      };
    }
  }

  if (headMatches(evidenceHash, currentHead)) {
    return {
      fresh: true,
      reason: 'evidence 对应当前 HEAD',
      currentHead,
      changedFiles: [],
      materialFiles: [],
    };
  }

  try {
    const changedFiles = changedFilesBetween(projectRoot, evidenceHash, 'HEAD');
    const materialFiles = changedFiles.filter(f => !isStoryMetadataPath(f));
    if (materialFiles.length === 0) {
      return {
        fresh: true,
        reason: `evidence 后有 ${changedFiles.length} 个 metadata-only 变更，不失效`,
        currentHead,
        changedFiles,
        materialFiles,
      };
    }
    return {
      fresh: false,
      reason: `evidence 基于 ${evidenceHash.slice(0, 7)}，但 HEAD 是 ${currentHead.slice(0, 7)}，有代码变更: ${materialFiles.slice(0, 5).join(', ')}`,
      currentHead,
      changedFiles,
      materialFiles,
    };
  } catch {
    return {
      fresh: false,
      reason: `evidence hash ${evidenceHash.slice(0, 7)} 与 HEAD ${currentHead.slice(0, 7)} 不匹配，且无法比较 git diff`,
      currentHead,
      changedFiles: [],
      materialFiles: [],
    };
  }
}
