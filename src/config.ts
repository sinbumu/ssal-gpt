import { homedir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import {
  mkdirSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export function runtimePath() {
  const path = resolve(process.env.SSAL_DATA_DIR || join(homedir(), '.local/share/ssal-gpt'));
  const rel = relative(process.cwd(), path);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error('SSAL_DATA_DIR must be outside the source checkout.');
  }
  return privateDirectory(path);
}

export function writePrivate(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function acquireLock(dir: string) {
  const path = join(dir, 'process.lock');
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') alive = true;
    }
    if (alive) throw new Error('Another ssal-gpt process owns this data directory.');
    unlinkSync(path);
  }
  writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  return () => {
    if (existsSync(path)) unlinkSync(path);
  };
}
