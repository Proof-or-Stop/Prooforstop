/** Shared types. Pure data — no behaviour, no I/O. */

export interface OwnerLease {
  readonly sessionId?: string;
  readonly hostname?: string;
  readonly pid?: number;
  readonly command?: string;
  readonly cwd?: string;
  readonly acquiredAt?: string;
  readonly heartbeatAt?: string;
  readonly sessionSource?: string;
}

export interface StoryNode {
  readonly id: string;
  readonly title: string;
  readonly phase: string;
  readonly type?: string;
  readonly pri?: string;
  /** ISO strings; the client renders them in the viewer's local zone. */
  readonly created: string;
  readonly ended: string;
  /** Transitive dependents — drives node size. */
  readonly depth: number;
  readonly indeg: number;
  readonly outdeg: number;
  readonly nItems: number;
  readonly nDone: number;
  readonly nEv: number;
  readonly nFind: number;
  readonly openFind: number;
  readonly inFlight: boolean;
  readonly wt: string | null;
  readonly lease: { readonly beat?: string; readonly cmd?: string } | null;
  readonly totalMs: number | null;
  readonly risk: readonly string[];
}

export type EdgeKind = 'dep' | 'ref';

export interface StoryEdge {
  /** Source depends on / builds on target. */
  readonly s: string;
  readonly t: string;
  readonly k: EdgeKind;
}

export interface StoryGraph {
  readonly stories: readonly StoryNode[];
  readonly edges: readonly StoryEdge[];
  readonly generatedAt: string;
}

export type FileKind = 'json' | 'jsonl' | 'text' | 'dir' | 'summary';

export interface StoryFile {
  readonly kind: FileKind;
  readonly bytes?: number;
  readonly data?: unknown;
  readonly rows?: readonly unknown[];
  readonly text?: string;
  readonly entries?: readonly string[];
  /** For files too large to ship whole. */
  readonly count?: number;
  readonly sample?: readonly unknown[];
  readonly keys?: readonly string[];
  /** True when `count` is estimated from a bounded head read, not an exact parse. */
  readonly estimated?: boolean;
}

export interface StoryDetail {
  readonly storyId: string;
  readonly dir: string;
  readonly worktree: string | null;
  readonly alsoIn: readonly string[];
  readonly files: Readonly<Record<string, StoryFile>>;
  readonly readAt: string;
}

export type SearchKind = 'story' | 'item' | 'intent' | 'evidence' | 'finding' | 'doc' | 'artifact';

export interface SearchHit {
  readonly storyId: string;
  readonly kind: SearchKind;
  readonly ref: string;
  readonly label: string;
  readonly snip: string;
  readonly score: number;
}

export interface Resolved {
  /** storyId -> directory holding the LIVE state. */
  readonly primary: Readonly<Record<string, string>>;
  /** storyId -> other directories holding the same story (dupes / stale main copy). */
  readonly extra: Readonly<Record<string, readonly string[]>>;
  /** storyId -> linked worktree path, when live state lives there. */
  readonly wt: Readonly<Record<string, string>>;
}
