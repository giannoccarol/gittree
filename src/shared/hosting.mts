/**
 * Normalized hosting-provider pull-request contract (ADR-0008, D6, A8).
 * GitHub/GitLab/Azure endpoint details stay behind this seam; these are the
 * shapes every adapter must produce for the renderer.
 */

export type HostingProviderId = 'github' | 'gitlab' | 'azure' | 'bitbucket';

/**
 * Raw provider payload: untrusted external JSON straight from the provider
 * API. Adapters read it defensively (`?.`); typed normalization happens in
 * the summary/detail models below, and handler-level validation lands at the
 * IPC seam.
 */
export type ProviderPayload = any;

export interface HostingApiResult {
  data: ProviderPayload;
  headers?: { get(name: string): string | null };
}

export interface PullRequestAuthor {
  login: string;
  avatarUrl: string;
  /** Azure DevOps carries a stable identity id alongside the login. */
  id?: string;
}

export interface PullRequestSummary {
  provider: HostingProviderId;
  id: number | string;
  number: number;
  title: string;
  author: PullRequestAuthor;
  source: string;
  target: string;
  headSha: string;
  state: string;
  draft: boolean;
  reviewStatus: string;
  ciStatus: string;
  /** Azure DevOps keeps the raw reviewer votes on the summary. */
  reviewers?: unknown;
}

export interface PullRequestFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number | undefined;
  deletions: number | undefined;
  binary: boolean;
  patch: string;
}

export interface ReviewerStatus {
  login: string;
  state: string;
  submittedAt?: string | undefined;
  /** Azure DevOps vote value (-10, 0, 5, 10). */
  vote?: number;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null | undefined;
  url: string;
}

export interface ThreadNote {
  id: number | null;
  author: string;
  body: string;
  createdAt: string | undefined;
  /** GitLab-only resolution state on individual notes. */
  resolved?: boolean;
  resolvable?: boolean;
}

export interface ReviewThread {
  id: string;
  commentId: number | null;
  path: string;
  line: number | null;
  side: string;
  resolved: boolean;
  author: string;
  body: string;
  createdAt: string | undefined;
  notes: ThreadNote[];
}

export interface PullRequestPermissions {
  review: boolean;
  resolveThreads: boolean;
  checkout: boolean;
  /** GitHub supports explicit "request changes" reviews; GitLab does not. */
  requestChanges?: boolean;
}

export interface PullRequestDetail {
  summary: PullRequestSummary;
  permissions: PullRequestPermissions;
  reviewers: ReviewerStatus[];
  checks: CheckRun[];
  files: PullRequestFile[];
  threads: ReviewThread[];
  headSha: string;
  mergeability: string;
}

export interface PullRequestListPage {
  items: PullRequestSummary[];
  page: number;
  hasMore: boolean;
}

export interface PullRequestDiffPage {
  files: PullRequestFile[];
  page: number;
  hasMore: boolean;
}

export interface HostedRepositoryRef {
  ownerPath: string;
  repository: string;
  /** Azure DevOps project/organization coordinates. */
  organization?: string;
  project?: string;
}

export interface HostingAccount {
  user?: { login?: string } | null;
}
