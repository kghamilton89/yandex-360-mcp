import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface StoredToken {
  client_id: string;
  user: string;
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds. */
  expires_at?: number;
  scope?: string;
  updated_at: number;
}

export async function readToken(file: string): Promise<StoredToken | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const data = JSON.parse(raw) as StoredToken;
  if (typeof data.access_token !== 'string' || !data.access_token) throw new Error(`Malformed token file: ${file}`);
  return data;
}

/** Atomic write, readable only by the current user. */
export async function writeToken(file: string, token: StoredToken): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export async function deleteToken(file: string): Promise<boolean> {
  try {
    await rm(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

const STALE_MS = 30_000;

/**
 * Cross-process lock (an exclusive mkdir) so concurrent servers don't both spend a
 * rotating refresh token. Locks older than 30s are treated as abandoned.
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for token lock ${lock}`);
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
