// Benchmark M5 lato Rust: sidecar binario via stdio NDJSON.
// Uso: node rust-poc/scripts/bench-sidecar.mjs <repo> [iterazioni] [binario]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const repoPath = process.argv[2] ?? root;
const iterations = Number(process.argv[3] ?? 20);
const binary = process.argv[4] ?? path.join(root, 'rust-poc', 'target', 'debug', 'gittree-sidecar');

const child = spawn(binary, { stdio: ['pipe', 'pipe', 'inherit'] });
child.stdout.setEncoding('utf8');
let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', chunk => {
  buffer += chunk;
  let at = buffer.indexOf('\n');
  while (at !== -1) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) {
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        entry(message);
      }
    }
    at = buffer.indexOf('\n');
  }
});

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, response =>
      response.error ? reject(new Error(response.error)) : resolve(response.result)
    );
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

async function bench(label, fn) {
  await fn(); // warmup
  const start = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    await fn();
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / iterations;
  console.log(`Rust ${label}: ${ms.toFixed(1)} ms/media (${iterations} iterazioni)`);
}

await bench('graph.page limit 500', () =>
  request('graph.page', { repo: repoPath, offset: 0, limit: 500 })
);

await bench('status completo', () => request('status', { repo: repoPath }));

child.kill();
