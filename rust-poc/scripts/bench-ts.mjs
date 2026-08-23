// Benchmark M5 lato TypeScript: simple-git su repo grande.
// Uso: node rust-poc/scripts/bench-ts.mjs <repo> [iterazioni]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { simpleGit } = require(path.join(root, 'node_modules', 'simple-git'));

const repoPath = process.argv[2] ?? root;
const iterations = Number(process.argv[3] ?? 20);
const git = simpleGit(repoPath);

async function bench(label, fn) {
  await fn(); // warmup
  const start = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    await fn();
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / iterations;
  console.log(`TS ${label}: ${ms.toFixed(1)} ms/media (${iterations} iterazioni)`);
}

await bench('graph.page completo (log+refs)', async () => {
  const raw = await git.raw([
    'log', '--all', '--topo-order', '--date-order', '--parents', '-z',
    '--skip=0', '--max-count=501', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s'
  ]);
  if (!raw.length) throw new Error('output vuoto');
  const refs = await git.raw([
    'for-each-ref', '--format=%(refname)\t%(refname:short)\t%(objectname)\t%(upstream:short)',
    'refs/heads', 'refs/remotes', 'refs/tags'
  ]);
  await git.revparse('HEAD');
  if (!refs.length) throw new Error('refs vuote');
});

await bench('status completo', () => git.status());
