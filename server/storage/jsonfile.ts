import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Write a file atomically: write to a temp file in the same directory, fsync, then rename. */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const handle = await fsp.open(tmp, 'w', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Windows can briefly lock the destination (antivirus, indexer); retry a few times.
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

export function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Serialises async operations per key so concurrent writes to one file never interleave. */
export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.chains.set(key, settled);
    settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }
}

/** A JSON-backed collection kept in memory and persisted atomically on every change. */
export class JsonCollection<T extends { id: string }> {
  private items = new Map<string, T>();
  private loaded = false;
  private mutex = new KeyedMutex();
  constructor(private file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const list = await readJson<T[]>(this.file, []);
    for (const item of list) this.items.set(item.id, item);
    this.loaded = true;
  }

  all(): T[] {
    return [...this.items.values()];
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  async put(item: T): Promise<T> {
    this.items.set(item.id, item);
    await this.flush();
    return item;
  }

  async update(id: string, fn: (item: T) => T): Promise<T | undefined> {
    const cur = this.items.get(id);
    if (!cur) return undefined;
    const next = fn(cur);
    this.items.set(id, next);
    await this.flush();
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const had = this.items.delete(id);
    if (had) await this.flush();
    return had;
  }

  private flush(): Promise<void> {
    return this.mutex.run('flush', () => writeFileAtomic(this.file, JSON.stringify(this.all(), null, 1)));
  }
}
