import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeFileAtomic, KeyedMutex } from './jsonfile.js';
import { registerSecret } from '../logger.js';

interface EncryptedValue {
  iv: string;
  tag: string;
  data: string;
  updatedAt: string;
}
type SecretFile = Record<string, Record<string, EncryptedValue>>;

/**
 * Server-side credential store. Values are encrypted at rest with AES-256-GCM.
 * The key comes from VOIDCRAFT_SECRET_KEY or a generated key file readable only
 * by the current user. Credentials are never returned to the browser; the API
 * exposes only a masked hint.
 */
export class SecretStore {
  private key: Buffer;
  private file: string;
  private cache: SecretFile = {};
  private mutex = new KeyedMutex();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'secrets.json');
    this.key = SecretStore.loadKey(dataDir);
  }

  private static loadKey(dataDir: string): Buffer {
    const env = process.env.VOIDCRAFT_SECRET_KEY;
    if (env) return crypto.createHash('sha256').update(env).digest();
    const keyFile = path.join(dataDir, 'secret.key');
    if (fs.existsSync(keyFile)) {
      const raw = fs.readFileSync(keyFile, 'utf8').trim();
      return Buffer.from(raw, 'base64');
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
    return key;
  }

  async load(): Promise<void> {
    this.cache = await readJson<SecretFile>(this.file, {});
    for (const provider of Object.keys(this.cache)) {
      for (const field of Object.keys(this.cache[provider])) registerSecret(this.getStored(provider, field));
    }
  }

  private encrypt(value: string): EncryptedValue {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'), updatedAt: new Date().toISOString() };
  }

  private decrypt(v: EncryptedValue): string | null {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(v.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(v.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(v.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return null; // key changed or file tampered with
    }
  }

  getStored(providerId: string, field: string): string | null {
    const v = this.cache[providerId]?.[field];
    return v ? this.decrypt(v) : null;
  }

  async set(providerId: string, field: string, value: string): Promise<void> {
    const trimmed = value.trim();
    registerSecret(trimmed);
    this.cache[providerId] = { ...(this.cache[providerId] ?? {}), [field]: this.encrypt(trimmed) };
    await this.persist();
  }

  async clear(providerId: string, field?: string): Promise<void> {
    if (!this.cache[providerId]) return;
    if (field) delete this.cache[providerId][field];
    else delete this.cache[providerId];
    await this.persist();
  }

  private persist(): Promise<void> {
    return this.mutex.run('persist', () => writeFileAtomic(this.file, JSON.stringify(this.cache, null, 1), 0o600));
  }
}

export function maskSecret(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}
