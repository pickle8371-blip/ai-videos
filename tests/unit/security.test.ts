import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { redact, registerSecret } from '../../server/logger';
import { SecretStore, maskSecret } from '../../server/storage/secrets';
import { sniffBuffer } from '../../server/media/filetype';
import { extractErrorMessage } from '../../server/providers/http';

describe('credential protection', () => {
  it('encrypts secrets at rest and decrypts them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-sec-'));
    const store = new SecretStore(dir);
    await store.load();
    await store.set('replicate', 'apiToken', 'r8_supersecretvalue123456');
    const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
    expect(raw).not.toContain('supersecret');
    const again = new SecretStore(dir);
    await again.load();
    expect(again.getStored('replicate', 'apiToken')).toBe('r8_supersecretvalue123456');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'secret.key')).mode & 0o077).toBe(0);
    await again.clear('replicate');
    expect(again.getStored('replicate', 'apiToken')).toBeNull();
  });

  it('masks secrets for display', () => {
    expect(maskSecret('sk-abcdefghijkl1234')).toBe('••••1234');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret(null)).toBeNull();
  });

  it('redacts secrets from log lines', () => {
    registerSecret('my-registered-secret-value');
    expect(redact('token my-registered-secret-value used')).not.toContain('my-registered-secret-value');
    expect(redact('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redact({ apiKey: 'sk-1234567890abcdef' })).not.toContain('1234567890abcdef');
    expect(redact('key AIzaSyA1234567890123456789012345')).not.toContain('AIzaSyA1234567890');
  });

  it('extracts readable provider error messages', () => {
    expect(extractErrorMessage('{"error":{"message":"bad prompt"}}')).toBe('bad prompt');
    expect(extractErrorMessage('{"detail":[{"msg":"field required"}]}')).toBe('field required');
    expect(extractErrorMessage('<html><body>Gateway timeout</body></html>')).toBe('Gateway timeout');
  });
});

describe('file type sniffing', () => {
  const b = (...parts: Array<string | number[]>) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))).concat(Buffer.alloc(16)));
  it('detects supported formats by magic bytes', () => {
    expect(sniffBuffer(b([0x89], 'PNG\r\n'))?.ext).toBe('png');
    expect(sniffBuffer(b([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe('jpg');
    expect(sniffBuffer(b('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))?.ext).toBe('webp');
    expect(sniffBuffer(b([0, 0, 0, 0x20], 'ftypisom'))?.ext).toBe('mp4');
    expect(sniffBuffer(b([0, 0, 0, 0x14], 'ftypqt  '))?.ext).toBe('mov');
    expect(sniffBuffer(b('ID3', [3, 0]))?.ext).toBe('mp3');
    expect(sniffBuffer(b('RIFF', [0, 0, 0, 0], 'WAVEfmt '))?.ext).toBe('wav');
    expect(sniffBuffer(b('OggS'))?.ext).toBe('ogg');
  });
  it('rejects unknown content regardless of extension', () => {
    expect(sniffBuffer(Buffer.from('<?php echo 1; ?> this is not media at all'))).toBeNull();
    expect(sniffBuffer(Buffer.from('MZ\x90\x00 executable header padding....'))).toBeNull();
    expect(sniffBuffer(Buffer.alloc(4))).toBeNull();
  });
});
