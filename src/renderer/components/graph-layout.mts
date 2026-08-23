export interface CommitRef {
  hash?: unknown;
  parents?: unknown[];
  lane?: unknown;
}

export interface GraphCommit {
  hash: string;
  parents?: string[];
}

export interface LayoutState {
  lanes: Array<string | null>;
}

export interface LayoutRow {
  commit: GraphCommit;
  lane: number;
  incoming: boolean;
  before: Array<string | null>;
  parents: Array<{ hash: string; lane: number; kind: string }>;
}

export interface LayoutResult {
  rows: LayoutRow[];
  laneCount: number;
  nextState: LayoutState;
}

export interface Segment {
  lane: number;
  path: string;
}

function firstAvailableLane(lanes: Array<string | null>): number {
  const empty = lanes.indexOf(null);
  return empty >= 0 ? empty : lanes.length;
}

function trimTrailingLanes(lanes: Array<string | null>): void {
  while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
}

export function layoutGraph(commits: unknown, previousState: LayoutState = { lanes: [] }): LayoutResult {
  const lanes: Array<string | null> = Array.isArray(previousState?.lanes) ? [...previousState.lanes] : [];
  const rows: LayoutRow[] = [];
  let laneCount = lanes.length;

  for (const commit of (commits ?? []) as GraphCommit[]) {
    const parents: string[] = Array.isArray(commit.parents) ? (commit.parents as unknown[]).filter(Boolean).map(String) : [];
    let lane = lanes.indexOf(commit.hash);
    const incoming = lane >= 0;
    if (lane < 0) {
      lane = firstAvailableLane(lanes);
      lanes[lane] = commit.hash;
    }

    const before = [...lanes];
    const parentLayouts: Array<{ hash: string; lane: number; kind: string }> = [];
    const firstParent = parents[0];

    if (!firstParent) {
      lanes[lane] = null;
    } else {
      const existingFirstParentLane = lanes.findIndex(
        (value, index) => index !== lane && value === firstParent
      );
      if (existingFirstParentLane >= 0) {
        lanes[lane] = null;
        parentLayouts.push({
          hash: firstParent,
          lane: existingFirstParentLane,
          kind: 'first-parent'
        });
      } else {
        lanes[lane] = firstParent;
        parentLayouts.push({ hash: firstParent, lane, kind: 'first-parent' });
      }
    }

    for (let index = 1; index < parents.length; index += 1) {
      const parentHash = parents[index];
      let parentLane = lanes.indexOf(parentHash);
      if (parentLane < 0) {
        parentLane = firstAvailableLane(lanes);
        lanes[parentLane] = parentHash;
      }
      parentLayouts.push({
        hash: parentHash,
        lane: parentLane,
        kind: 'merge-parent'
      });
    }

    trimTrailingLanes(lanes);
    laneCount = Math.max(laneCount, before.length, lanes.length, lane + 1);
    rows.push({
      commit,
      lane,
      incoming,
      before,
      parents: parentLayouts
    });
  }

  return {
    rows,
    laneCount,
    nextState: { lanes }
  };
}

export function createGraphSegments(row: { before?: Array<string | null>; lane: number; incoming?: boolean; parents?: Array<{ lane: number }> }, rowHeight: number): Segment[] {
  const x = (lane: number): number => 12 + lane * 18;
  const midpoint = rowHeight / 2;
  const top = -1;
  const bottom = rowHeight + 1;
  const segments: Segment[] = [];

  (row.before ?? []).forEach((hash, lane) => {
    if (!hash || lane === row.lane) return;
    segments.push({
      lane,
      path: `M ${x(lane)} ${top} L ${x(lane)} ${bottom}`
    });
  });
  if (row.incoming) {
    segments.push({
      lane: row.lane,
      path: `M ${x(row.lane)} ${top} L ${x(row.lane)} ${midpoint}`
    });
  }
  for (const parent of row.parents ?? []) {
    const from = x(row.lane);
    const to = x(parent.lane);
    segments.push({
      lane: parent.lane,
      path: from === to
        ? `M ${from} ${midpoint} L ${to} ${bottom}`
        : `M ${from} ${midpoint} C ${from} ${midpoint + 10}, ${to} ${bottom - 10}, ${to} ${bottom}`
    });
  }
  return segments;
}

export const GraphLayout = {
  layoutGraph,
  createGraphSegments
};

if (typeof window !== 'undefined') {
  (window as unknown as { GraphLayout: typeof GraphLayout }).GraphLayout = GraphLayout;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = GraphLayout;
}
