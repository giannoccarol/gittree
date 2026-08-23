const MAX_TITLE_LENGTH = 256;
const MAX_WORK_ITEMS = 20;
const HASH_PREFIX_LENGTH = 8;
const REFERENCED_ID_PATTERN = /(?:AB)?#(\d+)/gi;
const BARE_BRANCH_ID_PATTERN = /(?:^|[/_-])(\d{5,})(?=[-_/]|$)/g;

interface CommitLike {
  message?: unknown;
  hash?: unknown;
}

export interface PrefillSource {
  source?: unknown;
  commits?: CommitLike[];
}

export interface PrefillDraft {
  title: string;
  body: string;
  workItems: number[];
}

function subjectOf(commit?: CommitLike): string {
  return String(commit?.message ?? '').split('\n')[0].trim();
}

function collectWorkItemIds(branch: unknown, commits?: CommitLike[]): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  const scan = (text: unknown, bareIds: boolean) => {
    for (const match of String(text ?? '').matchAll(REFERENCED_ID_PATTERN)) {
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (!bareIds) return;
    for (const match of String(text ?? '').matchAll(BARE_BRANCH_ID_PATTERN)) {
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  };
  scan(branch, true);
  for (const commit of commits ?? []) scan(subjectOf(commit), false);
  return ids.slice(0, MAX_WORK_ITEMS);
}

function buildTitle(source: unknown, commits?: CommitLike[]): string {
  const subject = subjectOf(commits?.[0]);
  const candidate = subject || String(source ?? '').trim();
  return candidate.slice(0, MAX_TITLE_LENGTH);
}

function buildBody(commits?: CommitLike[]): string {
  return (commits ?? [])
    .map(commit => {
      const subject = subjectOf(commit);
      const hash = String(commit?.hash ?? '').slice(0, HASH_PREFIX_LENGTH);
      return `- ${subject}${hash ? ` (${hash})` : ''}`;
    })
    .join('\n');
}

export function build({ source, commits }: PrefillSource): PrefillDraft {
  return {
    title: buildTitle(source, commits),
    body: buildBody(commits),
    workItems: collectWorkItemIds(source, commits)
  };
}

export const PrCreatePrefill = Object.freeze({ build });

if (typeof window !== 'undefined') {
  (window as unknown as { PrCreatePrefill: typeof PrCreatePrefill }).PrCreatePrefill = PrCreatePrefill;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = PrCreatePrefill;
}
