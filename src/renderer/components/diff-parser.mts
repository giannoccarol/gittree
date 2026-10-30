export interface HunkRange {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export type RowKind = 'hunk' | 'file' | 'no-newline' | 'header' | 'add' | 'del' | 'context' | 'empty';

export interface UnifiedRow {
  content: string;
  kind: RowKind;
  oldLine: number | null;
  newLine: number | null;
}

export interface SplitPair {
  type: 'pair';
  left: UnifiedRow;
  right: UnifiedRow;
}

export interface SplitFull extends UnifiedRow {
  type: 'full';
}

export type SplitRow = SplitPair | SplitFull;

function headerRange(line: unknown): HunkRange | null {
  const match = String(line ?? '').match(
    /^@@@? -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@@?/
  );
  return match
    ? {
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? 1)
      }
    : null;
}

function metadataKind(line: string): RowKind | null {
  if (line.startsWith('diff --git')) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line === '\\ No newline at end of file') return 'no-newline';
  if (
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('similarity') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ') ||
    line.startsWith('old mode ') ||
    line.startsWith('new mode ')
  ) return 'header';
  return null;
}

export function parseUnified(patch: unknown): UnifiedRow[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let inHunk = false;
  return String(patch ?? '').split('\n').map(content => {
    const metadata = metadataKind(content);
    if (metadata === 'hunk') {
      const range = headerRange(content);
      oldLine = range?.oldStart ?? null;
      newLine = range?.newStart ?? null;
      inHunk = Boolean(range);
      return { content, kind: 'hunk', oldLine: null, newLine: null };
    }
    if (metadata === 'file') {
      inHunk = false;
      return { content, kind: metadata, oldLine: null, newLine: null };
    }
    if (metadata === 'no-newline') {
      return { content, kind: metadata, oldLine: null, newLine: null };
    }
    if (!inHunk) {
      return { content, kind: (metadata ?? 'header') as RowKind, oldLine: null, newLine: null };
    }
    if (content.startsWith('+')) {
      const row: UnifiedRow = { content, kind: 'add', oldLine: null, newLine };
      if (newLine !== null) newLine += 1;
      return row;
    }
    if (content.startsWith('-')) {
      const row: UnifiedRow = { content, kind: 'del', oldLine, newLine: null };
      if (oldLine !== null) oldLine += 1;
      return row;
    }
    const row: UnifiedRow = { content, kind: 'context', oldLine, newLine };
    if (oldLine !== null) oldLine += 1;
    if (newLine !== null) newLine += 1;
    return row;
  });
}

function emptySide(): UnifiedRow {
  return { content: '', kind: 'empty', oldLine: null, newLine: null };
}

export function parseSplit(patch: unknown): SplitRow[] {
  return pairRows(parseUnified(patch));
}

/** Pairs removed and added lines of already parsed unified rows side by side. */
export function pairRows(rows: UnifiedRow[]): SplitRow[] {
  const output: SplitRow[] = [];
  let deletions: UnifiedRow[] = [];
  let additions: UnifiedRow[] = [];
  const flush = (): void => {
    const count = Math.max(deletions.length, additions.length);
    for (let index = 0; index < count; index += 1) {
      output.push({
        type: 'pair',
        left: deletions[index] ?? emptySide(),
        right: additions[index] ?? emptySide()
      });
    }
    deletions = [];
    additions = [];
  };

  for (const row of rows) {
    if (row.kind === 'del') {
      deletions.push(row);
    } else if (row.kind === 'add') {
      additions.push(row);
    } else if (row.kind === 'context') {
      flush();
      output.push({ type: 'pair', left: row, right: row });
    } else {
      flush();
      output.push({ type: 'full', ...row });
    }
  }
  flush();
  return output;
}

export interface DiffFileSummary {
  path: string;
  oldPath: string | null;
  status: 'A' | 'D' | 'R' | 'M';
  additions: number;
  deletions: number;
  binary: boolean;
  modeChange: { from: string; to: string } | null;
}

const BINARY_LINE = /^(?:Binary files .* differ|GIT binary patch)$/;

function filePathOf(content: string): string {
  const match = content.match(/^diff --git a\/(.+) b\/(.+)$/);
  return match ? match[2] : content;
}

/**
 * Describes every file of a parsed patch and returns the rows worth showing:
 * Git's per-file header lines (index, ---/+++, modes, renames) become file
 * properties, except the binary notice, which stays as the file's content.
 */
export function summarizeFiles(rows: UnifiedRow[]): { files: DiffFileSummary[]; rows: UnifiedRow[] } {
  const files: DiffFileSummary[] = [];
  const visible: UnifiedRow[] = [];
  let current: DiffFileSummary | null = null;
  let oldMode = '';
  for (const row of rows) {
    if (row.kind === 'file') {
      current = {
        path: filePathOf(row.content),
        oldPath: null,
        status: 'M',
        additions: 0,
        deletions: 0,
        binary: false,
        modeChange: null
      };
      oldMode = '';
      files.push(current);
      visible.push(row);
      continue;
    }
    if (row.kind === 'header') {
      const content = row.content;
      if (BINARY_LINE.test(content)) {
        if (current) current.binary = true;
        visible.push(row);
      } else if (current) {
        if (content.startsWith('new file mode ')) current.status = 'A';
        else if (content.startsWith('deleted file mode ')) current.status = 'D';
        else if (content.startsWith('rename from ')) {
          current.status = 'R';
          current.oldPath = content.slice('rename from '.length);
        } else if (content.startsWith('rename to ')) {
          current.status = 'R';
          current.path = content.slice('rename to '.length);
        } else if (content.startsWith('old mode ')) {
          oldMode = content.slice('old mode '.length);
        } else if (content.startsWith('new mode ')) {
          current.modeChange = { from: oldMode, to: content.slice('new mode '.length) };
        }
      }
      continue;
    }
    if (current && row.kind === 'add') current.additions += 1;
    else if (current && row.kind === 'del') current.deletions += 1;
    visible.push(row);
  }
  return { files, rows: visible };
}

export interface HunkSourceLine {
  content?: unknown;
  type?: unknown;
}

export interface NumberableHunk {
  oldRange?: { start?: number };
  newRange?: { start?: number };
  lines?: Array<HunkSourceLine | string>;
}

export function numberHunk(hunk: NumberableHunk): UnifiedRow[] {
  let oldLine = hunk?.oldRange?.start ?? 0;
  let newLine = hunk?.newRange?.start ?? 0;
  return (hunk?.lines ?? []).map(sourceLine => {
    const content = typeof sourceLine === 'string'
      ? sourceLine
      : String((sourceLine as HunkSourceLine)?.content ?? '');
    const suppliedType = typeof sourceLine === 'object' ? (sourceLine as HunkSourceLine)?.type : null;
    if (content === '\\ No newline at end of file') {
      return { ...(sourceLine as object), content, kind: 'no-newline' as RowKind, oldLine: null, newLine: null } as UnifiedRow;
    }
    const kind: RowKind = suppliedType === 'delete' || content.startsWith('-')
      ? 'del'
      : suppliedType === 'add' || content.startsWith('+')
        ? 'add'
        : 'context';
    if (kind === 'add') {
      const row: UnifiedRow = { ...(sourceLine as object), content, kind, oldLine: null, newLine } as UnifiedRow;
      newLine += 1;
      return row;
    }
    if (kind === 'del') {
      const row: UnifiedRow = { ...(sourceLine as object), content, kind, oldLine, newLine: null } as UnifiedRow;
      oldLine += 1;
      return row;
    }
    const row: UnifiedRow = { ...(sourceLine as object), content, kind, oldLine, newLine } as UnifiedRow;
    oldLine += 1;
    newLine += 1;
    return row;
  });
}

export function maxDigits(rows: unknown): number {
  let maximum = 1;
  for (const row of (rows ?? []) as Array<{ type?: string; left?: { oldLine?: unknown; newLine?: unknown }; right?: { oldLine?: unknown; newLine?: unknown }; oldLine?: unknown; newLine?: unknown }>) {
    const candidates = row.type === 'pair'
      ? [row.left?.oldLine, row.left?.newLine, row.right?.oldLine, row.right?.newLine]
      : [row.oldLine, row.newLine];
    for (const value of candidates) {
      if (Number.isInteger(value)) maximum = Math.max(maximum, String(value).length);
    }
  }
  return maximum;
}

export const DiffParser = {
  headerRange,
  parseUnified,
  parseSplit,
  pairRows,
  summarizeFiles,
  numberHunk,
  maxDigits
};

if (typeof window !== 'undefined') {
  (window as unknown as { DiffParser: typeof DiffParser }).DiffParser = DiffParser;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = DiffParser;
}
