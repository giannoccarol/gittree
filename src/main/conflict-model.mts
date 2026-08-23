import { createHash } from 'node:crypto';

export const MAX_CONFLICT_RESULT_BYTES = 50 * 1024 * 1024;

export interface ConflictBlock {
  id: string;
  startLine: number;
  endLine: number;
  base: string | null;
  current: string;
  incoming: string;
  smartCombination: string | null;
  startOffset: number;
  endOffset: number;
}

function splitLinesWithEndings(content: unknown): string[] {
  return String(content || '').match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
}

function safeCombination(
  base: string | null,
  current: string,
  incoming: string
): string | null {
  if (current === incoming) return current;
  if (base !== null && current === base) return incoming;
  if (base !== null && incoming === base) return current;
  return null;
}

export function parseConflictBlocks(content: unknown): ConflictBlock[] {
  const lines = splitLinesWithEndings(content);
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length;
  }

  const blocks: ConflictBlock[] = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (!/^<<<<<<<(?:\s|$)/.test(lines[start])) continue;
    let baseMarker = -1;
    let separator = -1;
    let end = -1;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (baseMarker === -1 && separator === -1 && /^\|\|\|\|\|\|\|(?:\s|$)/.test(lines[index])) {
        baseMarker = index;
      } else if (separator === -1 && /^=======(?:\r?\n|\r)?$/.test(lines[index])) {
        separator = index;
      } else if (separator !== -1 && /^>>>>>>>(?:\s|$)/.test(lines[index])) {
        end = index;
        break;
      }
    }
    if (separator === -1 || end === -1) continue;

    const currentEnd = baseMarker === -1 ? separator : baseMarker;
    const current = lines.slice(start + 1, currentEnd).join('');
    const base = baseMarker === -1
      ? null
      : lines.slice(baseMarker + 1, separator).join('');
    const incoming = lines.slice(separator + 1, end).join('');
    const startOffset = offsets[start];
    const endOffset = offsets[end] + lines[end].length;
    blocks.push({
      id: createHash('sha256')
        .update(`${startOffset}\0${current}\0${incoming}`)
        .digest('hex'),
      startLine: start + 1,
      endLine: end + 1,
      base,
      current,
      incoming,
      smartCombination: safeCombination(base, current, incoming),
      startOffset,
      endOffset
    });
    start = end;
  }
  return blocks;
}

export function hasUnresolvedMarkers(content: unknown): boolean {
  return parseConflictBlocks(content).length > 0 ||
    /^(?:<<<<<<<|>>>>>>>)(?:\s|$)/m.test(String(content || ''));
}

export function conflictSnapshot(buffers: Array<Buffer | string | null | undefined>): string {
  const hash = createHash('sha256');
  for (const buffer of buffers) {
    const value = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    hash.update(String(value.length));
    hash.update('\0');
    hash.update(value);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export { safeCombination };
