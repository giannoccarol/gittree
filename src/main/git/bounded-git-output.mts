import { spawn } from 'node:child_process';

export interface BoundedGitOutput {
  text: string;
  truncated: boolean;
}

const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Runs one Git command and keeps at most `maxBytes` of its stdout. When the
 * limit is reached the process is stopped and the text is cut at the last
 * complete line, so callers never buffer or forward an unbounded payload
 * (for example the diff of a branch with thousands of commits).
 */
export function readBoundedGitOutput(
  repoPath: string,
  args: string[],
  maxBytes: number
): Promise<BoundedGitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      windowsHide: true,
      env: process.env
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let truncated = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = maxBytes - stdoutSize;
      if (chunk.length > room) {
        stdout.push(chunk.subarray(0, Math.max(0, room)));
        stdoutSize = maxBytes;
        truncated = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
      stdoutSize += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrSize >= MAX_STDERR_BYTES) return;
      stderr.push(chunk);
      stderrSize += chunk.length;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (!truncated && code !== 0) {
        const message = Buffer.concat(stderr).toString('utf8').trim();
        reject(new Error(message || `Git exited with code ${code}`));
        return;
      }
      let text = Buffer.concat(stdout).toString('utf8');
      if (truncated) {
        const lastNewline = text.lastIndexOf('\n');
        text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
      }
      resolve({ text, truncated });
    });
  });
}
