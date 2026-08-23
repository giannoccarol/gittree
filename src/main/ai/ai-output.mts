const TITLE_PATTERN = /^\s*TITLE\s*:\s*(.*)$/im;
const BODY_PATTERN = /^\s*BODY\s*:\s*([\s\S]*)$/im;
const HASH_LINE_PATTERN = /^\s*HASH\s*:\s*([0-9a-f]{7,40})(?:\s*[—|-]\s*(.*))?\s*$/i;

export interface SearchMatch {
  hash: string;
  reason: string;
}

export interface CommitCandidate {
  hash?: string;
  subject?: string;
}

export function parseSearchOutput(raw: unknown, candidates: CommitCandidate[]): SearchMatch[] {
  const known = new Set((candidates || []).map(candidate => (
    String(candidate.hash || '').toLowerCase()
  )));
  const matches = [];
  const seen = new Set();
  for (const line of String(raw || '').split(/\r?\n/)) {
    const match = line.match(HASH_LINE_PATTERN);
    if (!match) continue;
    const hash = match[1].toLowerCase();
    if (!known.has(hash) || seen.has(hash)) continue;
    seen.add(hash);
    matches.push({ hash, reason: String(match[2] || '').trim() });
    if (matches.length >= 20) break;
  }
  return matches;
}

function truncate(value: unknown, limit: number): string {
  const text = String(value || '').replace(/\s+$/u, '');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export interface AiOutputOptions {
  maxTitleLength?: number;
  maxBodyLength?: number;
}

export interface AiOutput {
  summary: string;
  body: string;
}

export function parseAiOutput(
  raw: unknown,
  { maxTitleLength = 200, maxBodyLength = 100000 }: AiOutputOptions = {}
): AiOutput {
  const text = String(raw || '');
  const titleMatch = text.match(TITLE_PATTERN);
  const bodyMatch = text.match(BODY_PATTERN);
  let summary;
  let body;
  if (titleMatch) {
    summary = titleMatch[1].trim();
    if (bodyMatch) body = bodyMatch[1].trim();
    else {
      const remainder = text.slice((titleMatch.index || 0) + titleMatch[0].length).trim();
      body = remainder.replace(/^\s*BODY\s*:\s*/i, '').trim();
    }
  } else {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    summary = lines[0] || '';
    body = lines.slice(1).join('\n').trim();
  }
  if (!summary) {
    throw new Error('The AI provider did not return a commit title');
  }
  return {
    summary: truncate(summary.replace(/^['"`]+|['"`]+$/g, ''), maxTitleLength),
    body: truncate(body, maxBodyLength)
  };
}

export function buildCommitPrompt({ diff, hint, language }: { diff: string; hint?: string; language?: string }): string {
  const targetLanguage = language === 'it' ? 'Italian' : 'English';
  const hintLine = hint ? `\nAdditional hint from the user: ${hint}\n` : '';
  return [
    'You are the commit-message assistant of a Git desktop client.',
    'Write a commit message for the staged changes below.',
    `Write the title and body in ${targetLanguage}.`,
    'Use a conventional commit prefix when the intent is clear',
    '(feat, fix, refactor, perf, docs, test, chore).',
    'Keep the title under 72 characters, imperative mood, no trailing period.',
    'The body must explain what changed and why, in at most 8 markdown lines.',
    'Answer with exactly this format and nothing else:',
    'TITLE: <title>',
    'BODY: <body>',
    hintLine,
    '--- staged diff ---',
    diff
  ].filter(Boolean).join('\n');
}

export function buildExplainPrompt({ diff, language }: { diff: string; language?: string }): string {
  const targetLanguage = language === 'it' ? 'Italian' : 'English';
  return [
    'You are the changes-explainer assistant of a Git desktop client.',
    'Explain the uncommitted changes below to the developer who wrote them.',
    `Write the explanation in ${targetLanguage}.`,
    'Keep it under 12 markdown lines and cover: what the change does,',
    'which risks or side effects it may introduce, and what should be tested.',
    'Answer with exactly this format and nothing else:',
    'TITLE: <short heading>',
    'BODY: <explanation>',
    '--- changes diff ---',
    diff
  ].filter(Boolean).join('\n');
}

export function buildConflictPrompt({ file, base, current, incoming, language }: { file: string; base?: string; current?: string; incoming?: string; language?: string }): string {
  const targetLanguage = language === 'it' ? 'Italian' : 'English';
  return [
    'You are the merge-conflict advisor of a Git desktop client.',
    'Explain the conflict block below and suggest how to combine the two sides.',
    `Conflicted file: ${file}`,
    `Write the explanation in ${targetLanguage}.`,
    'Keep it under 12 markdown lines: what each side does, which parts overlap,',
    'and a concrete way to merge them without breaking either intent.',
    'Describe content only; never instruct the user to run commands.',
    'Answer with exactly this format and nothing else:',
    'TITLE: <short summary of the suggested resolution>',
    'BODY: <explanation and suggested combined code>',
    '--- base version ---',
    base || '(empty)',
    '--- current version (ours) ---',
    current || '(empty)',
    '--- incoming version (theirs) ---',
    incoming || '(empty)'
  ].filter(Boolean).join('\n');
}

export function buildCommitExplainPrompt({ message, author, date, diff, language }: { message: string; author?: string; date?: string; diff: string; language?: string }): string {
  const targetLanguage = language === 'it' ? 'Italian' : 'English';
  return [
    'You are the history-explainer assistant of a Git desktop client.',
    'Explain the commit below to a developer reading the repository history.',
    `Write the explanation in ${targetLanguage}.`,
    'Keep it under 12 markdown lines: what the commit changes, why,',
    'and any risks or follow-up work the reader should know.',
    'Answer with exactly this format and nothing else:',
    'TITLE: <one-line explanation>',
    'BODY: <explanation>',
    `Commit: ${message}`,
    `Author: ${author || 'unknown'} (${date || 'unknown date'})`,
    '--- commit diff ---',
    diff
  ].filter(Boolean).join('\n');
}

export function buildHistorySearchPrompt({ query, commits, language }: { query: string; commits: CommitCandidate[]; language?: string }): string {
  const targetLanguage = language === 'it' ? 'Italian' : 'English';
  const commitLines = (commits || [])
    .slice(0, 300)
    .map(commit => `${commit.hash} ${commit.subject}`);
  return [
    'You are the history-search assistant of a Git desktop client.',
    'The user asks a question about the repository history. Pick up to 10 commits',
    'from the list below whose subject (or likely content) answers the question.',
    `Write the reasons in ${targetLanguage}.`,
    'Answer with exactly this format, one line per commit, and nothing else:',
    'HASH: <hash> — <one-line reason why it matches>',
    'If nothing matches, answer with exactly: NO MATCHES',
    `Question: ${query}`,
    '--- candidate commits ---',
    ...commitLines
  ].filter(Boolean).join('\n');
}

export function buildBlamePrompt({ file, hash, rows, language }: { file: string; hash: string; rows: Array<{ hash?: unknown; author?: unknown; summary?: unknown }>; language?: string }): string {
  const targetLanguage = language === 'it' ? 'Italian' : 'English';
  const rowLines = (rows || [])
    .slice(0, 200)
    .map(row => `${row.hash} ${row.author} ${row.summary}`);
  return [
    'You are the history-narrator assistant of a Git desktop client.',
    'Explain the history of the file below from its git blame data.',
    `File: ${file}`,
    `At commit: ${hash}`,
    `Write the explanation in ${targetLanguage}.`,
    'Keep it under 12 markdown lines: who touched the file, in which order,',
    'and what each change was about according to the commit summaries.',
    'Answer with exactly this format and nothing else:',
    'TITLE: <short narrative title>',
    'BODY: <explanation>',
    '--- blame rows (hash author summary) ---',
    ...rowLines
  ].filter(Boolean).join('\n');
}

export function buildPrPrompt({ diff, commits, hint, language }: { diff: string; commits: CommitCandidate[]; hint?: string; language?: string }): string {
  const targetLanguage = language === 'it' ? 'Italian' : 'English';
  const commitLines = (commits || [])
    .slice(0, 30)
    .map(commit => `- ${commit}`)
    .join('\n');
  const hintLine = hint ? `\nAdditional hint from the user: ${hint}\n` : '';
  return [
    'You are the pull-request assistant of a Git desktop client.',
    `Write the pull-request title and description in ${targetLanguage}.`,
    'The title must be a short summary (under 90 characters).',
    'The description must summarize the change and mention notable commits,',
    'in at most 12 markdown lines.',
    'Answer with exactly this format and nothing else:',
    'TITLE: <title>',
    'BODY: <description>',
    '--- commits in the pull request ---',
    commitLines || '(none)',
    hintLine,
    '--- diff ---',
    diff
  ].filter(Boolean).join('\n');
}


