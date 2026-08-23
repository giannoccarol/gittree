// Genera i golden JSON eseguendo i parser TypeScript reali di src/.
// Serve Node >= 22.18 (type stripping nativo per .mts).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const fixtures = path.join(root, 'rust-poc', 'crates', 'gittree-core', 'tests', 'fixtures');

const patchParser = await import(
  pathToFileURL(path.join(root, 'src', 'main', 'git', 'patch-parser.mts')).href
);
const blameParser = await import(
  pathToFileURL(path.join(root, 'src', 'main', 'git', 'blame-parser.mts')).href
);
const diffParser = await import(
  pathToFileURL(path.join(root, 'src', 'renderer', 'components', 'diff-parser.mts')).href
);

const read = name => readFileSync(path.join(fixtures, name), 'utf8');
const writeJson = (name, value) => {
  writeFileSync(path.join(fixtures, name), `${JSON.stringify(value, null, 2)}\n`);
};

const unstagedPatch = read('worktree-file.patch');
const stagedPatch = read('staged-file.patch');
const unifiedAll = read('unified-all.patch');

writeJson(
  'expected-working-diff-unstaged.json',
  patchParser.parseWorkingDiff('file.txt', false, unstagedPatch)
);
writeJson(
  'expected-working-diff-staged.json',
  patchParser.parseWorkingDiff('file.txt', true, stagedPatch)
);
writeJson(
  'expected-blame.json',
  blameParser.parseBlamePorcelain(read('blame.porcelain'))
);
writeJson('expected-parse-unified.json', diffParser.parseUnified(unifiedAll));
writeJson('expected-parse-split.json', diffParser.parseSplit(unifiedAll));

const working = patchParser.parseWorkingDiff('file.txt', false, unstagedPatch);
const hunk = working.hunks[0];
writeJson(
  'expected-number-hunk.json',
  diffParser.numberHunk({
    oldRange: { start: hunk.oldRange?.start },
    newRange: { start: hunk.newRange?.start },
    lines: hunk.lines
  })
);
writeJson('expected-max-digits.json', {
  value: diffParser.maxDigits(diffParser.parseSplit(unifiedAll))
});

console.log('Golden aggiornati in', fixtures);
