export interface BlameRow {
  hash: string;
  originalLine: number;
  finalLine: number;
  author: string;
  summary: string;
}

export function parseBlamePorcelain(text: unknown): BlameRow[] {
  const rows: BlameRow[] = [];
  let current: BlameRow | null = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const hashMatch = line.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/);
    if (hashMatch) {
      current = {
        hash: hashMatch[1],
        originalLine: Number(hashMatch[2]),
        finalLine: Number(hashMatch[3]),
        author: '',
        summary: ''
      };
      rows.push(current);
      continue;
    }
    if (!current || line.startsWith('\t')) continue;
    const authorMatch = line.match(/^author (.*)$/);
    if (authorMatch) {
      current.author = authorMatch[1];
      continue;
    }
    const summaryMatch = line.match(/^summary (.*)$/);
    if (summaryMatch) current.summary = summaryMatch[1];
  }
  return rows;
}
