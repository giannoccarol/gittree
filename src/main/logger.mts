import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function sanitizeMessage(message: unknown): string {
  return String(message)
    .replace(/(ghp|gho|glpat|pat)[-_A-Za-z0-9]{8,}/g, '$1***')
    .replace(/(authorization[=:]\s*)[^\s,;]+/gi, '$1***')
    .replace(/(x-api-key[=:]\s*)[^\s,;]+/gi, '$1***')
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
    .replace(/(token[=:]\s*)[^\s,;]+/gi, '$1***');
}

export class Logger {
  directory: string | null;
  level: number;
  enabled: boolean;
  file: string | null;

  constructor(directory: string | null) {
    this.directory = directory;
    this.level = 2;
    this.enabled = Boolean(directory);
    this.file = directory ? path.join(directory, 'gittree.log') : null;
    if (directory) {
      fs.mkdirSync(directory, { recursive: true });
      this.rotate();
    }
  }

  setLevel(level: number): void {
    this.level = level;
  }

  log(level: number, message: unknown, details?: unknown): void {
    if (!this.enabled || level < this.level) return;
    const line = [
      new Date().toISOString(),
      ['debug', 'info', 'warn', 'error'][level] || 'info',
      sanitizeMessage(message),
      details !== undefined ? sanitizeMessage(JSON.stringify(details)) : ''
    ].join('\t');
    try {
      if (
        this.file &&
        fs.existsSync(this.file) &&
        fs.statSync(this.file).size > MAX_LOG_BYTES
      ) {
        this.rotate();
      }
      fs.appendFileSync(this.file!, `${line}\n`, 'utf8');
    } catch { /* logging must never break the app */ }
    if (level >= 2) {
      const method = level === 3 ? console.error : console.warn;
      method(`[GitTree] ${line}`);
    }
  }

  rotate(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    const rotated = `${this.file}.1`;
    try {
      fs.rmSync(rotated, { force: true });
      fs.renameSync(this.file, rotated);
    } catch { /* rotation is best effort */ }
  }

  debug(message: unknown, details?: unknown): void { this.log(0, message, details); }
  info(message: unknown, details?: unknown): void { this.log(1, message, details); }
  warn(message: unknown, details?: unknown): void { this.log(2, message, details); }
  error(message: unknown, details?: unknown): void { this.log(3, message, details); }
}
