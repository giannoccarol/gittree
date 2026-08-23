export type ConflictLineKind = 'marker' | 'separator' | 'current' | 'base' | 'incoming';

export interface ConflictBlock {
  startLine: number;
  endLine: number;
  base: string | null;
}

export interface HighlightLine {
  text: string;
  kind: ConflictLineKind | 'plain';
}

export function splitLines(content: unknown): string[] {
  return String(content ?? '').match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
}

function classifyBlockLines(block: ConflictBlock, lines: string[]): Map<number, ConflictLineKind> {
  const kinds = new Map<number, ConflictLineKind>();
  const start = block.startLine;
  const end = block.endLine;
  kinds.set(start, 'marker');
  kinds.set(end, 'marker');
  if (start >= end || end > lines.length) return kinds;

  const hasBase = block.base !== null;
  let baseMarker = -1;
  let separator = -1;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index - 1];
    if (baseMarker === -1 && separator === -1 && hasBase && /^\|\|\|\|\|\|\|(?:\s|$)/.test(line)) {
      baseMarker = index;
    } else if (separator === -1 && /^=======(?:\r?\n|\r)?$/.test(line)) {
      separator = index;
      break;
    }
  }
  if (separator === -1) return kinds;

  const currentEnd = baseMarker === -1 ? separator : baseMarker;
  for (let index = start + 1; index < currentEnd; index += 1) {
    kinds.set(index, 'current');
  }
  if (baseMarker !== -1) {
    kinds.set(baseMarker, 'marker');
    for (let index = baseMarker + 1; index < separator; index += 1) {
      kinds.set(index, 'base');
    }
  }
  kinds.set(separator, 'separator');
  for (let index = separator + 1; index < end; index += 1) {
    kinds.set(index, 'incoming');
  }
  return kinds;
}

export function buildHighlightLines(content: unknown, blocks: ConflictBlock[] = []): HighlightLine[] {
  const lines = splitLines(content);
  const classification = new Map<number, ConflictLineKind>();
  for (const block of blocks ?? []) {
    for (const [lineNumber, kind] of classifyBlockLines(block, lines)) {
      classification.set(lineNumber, kind);
    }
  }
  return lines.map((line, index) => ({
    text: line.replace(/\r?\n|\r$/, ''),
    kind: classification.get(index + 1) || 'plain'
  }));
}

export const ConflictHighlight = Object.freeze({
  buildHighlightLines,
  countUnresolved: (blocks?: ConflictBlock[]): number => (blocks ?? []).length,
  splitLines
});

if (typeof window !== 'undefined') {
  (window as unknown as { ConflictHighlight: typeof ConflictHighlight }).ConflictHighlight = ConflictHighlight;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = ConflictHighlight;
}
