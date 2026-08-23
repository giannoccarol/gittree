export interface DiffRow {
  [key: string]: unknown;
}

export interface FileGroup<Row = DiffRow> {
  header: Row | null;
  path: string | null;
  rows: Row[];
}

export interface LayoutFile<Row = DiffRow> extends FileGroup<Row> {
  top: number;
  height: number;
  contentTop: number;
  rowHeight: number;
  end: number;
}

export function groupRows<Row = DiffRow>(
  rows: unknown,
  { isFile, pathForFile = () => null }: { isFile?: (row: Row) => boolean; pathForFile?: (row: Row) => string | null } = {}
): FileGroup<Row>[] {
  const files: FileGroup<Row>[] = [];
  let current: FileGroup<Row> | null = null;
  for (const row of (rows ?? []) as Row[]) {
    if (isFile?.(row)) {
      current = { header: row, path: pathForFile(row), rows: [] };
      files.push(current);
    } else {
      if (!current) {
        current = { header: null, path: null, rows: [] };
        files.push(current);
      }
      current.rows.push(row);
    }
  }
  return files;
}

export function layoutFiles<Row = DiffRow>(files: unknown, {
  rowHeight = 22,
  headerHeight = 36,
  fileGap = 12
}: { rowHeight?: number; headerHeight?: number; fileGap?: number } = {}): { files: LayoutFile<Row>[]; totalHeight: number } {
  let top = 0;
  const layout: LayoutFile<Row>[] = ((files ?? []) as FileGroup<Row>[]).map((file, index) => {
    const rows = Array.isArray(file.rows) ? file.rows : [];
    const contentTop = file.header ? headerHeight : 0;
    const height = contentTop + rows.length * rowHeight;
    const result: LayoutFile<Row> = {
      ...file,
      rows,
      top,
      height,
      contentTop,
      rowHeight,
      end: top + height
    };
    top += height + (index < (files as FileGroup<Row>[]).length - 1 ? fileGap : 0);
    return result;
  });
  return { files: layout, totalHeight: top };
}

export function visibleFiles<Row = DiffRow>(files: unknown, scrollTop: unknown, viewportHeight: unknown, overscan = 220): LayoutFile<Row>[] {
  const currentTop = Number(scrollTop) || 0;
  const start = Math.max(0, currentTop - overscan);
  const end = Math.max(start, currentTop + (Number(viewportHeight) || 0) + overscan);
  return ((files ?? []) as LayoutFile<Row>[]).filter(file => file.end >= start && file.top <= end);
}

export const DiffLayout = {
  groupRows,
  layoutFiles,
  visibleFiles
};

if (typeof window !== 'undefined') {
  (window as unknown as { DiffLayout: typeof DiffLayout }).DiffLayout = DiffLayout;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = DiffLayout;
}
