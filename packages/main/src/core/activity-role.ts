export type ActivityRole = 'main' | 'intent' | 'reviewer' | 'implementer' | 'analyst' | 'unknown';

function normalizeRole(raw: string | null | undefined): ActivityRole | null {
  if (!raw) return null;
  const val = raw.trim().toLowerCase();
  if (!val) return null;
  if (['main', 'intent', 'reviewer', 'implementer', 'analyst', 'unknown'].includes(val)) {
    return val as ActivityRole;
  }
  if (val === 'test-intent') return 'intent';
  if (val === 'test-case-reviewer') return 'reviewer';
  if (val.includes('implementer')) return 'implementer';
  if (val.includes('analyst')) return 'analyst';
  return null;
}

export function inferActivityRole(args: unknown, explicitEnvRole?: string | null): ActivityRole | null {
  const envRole = normalizeRole(explicitEnvRole);
  if (envRole) return envRole;

  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const candidate = (args as Record<string, unknown>).agent;
    if (typeof candidate === 'string') {
      const parsed = normalizeRole(candidate);
      if (parsed) return parsed;
    }
  }

  return 'main';
}

export function formatRoleLabel(role: string | null | undefined): string {
  const normalized = normalizeRole(role);
  return normalized || 'unknown';
}
