/**
 * Minimal logger that scrubs anything that looks like a credential before
 * writing. Provider adapters must never log request headers, but this is a
 * second line of defence.
 */
const SECRET_PATTERNS: RegExp[] = [
  /(sk-[A-Za-z0-9_-]{8,})/g,
  /(r8_[A-Za-z0-9]{8,})/g,
  /(key_[A-Za-z0-9]{16,})/g,
  /(AIza[0-9A-Za-z_-]{20,})/g,
  /(Bearer\s+)[A-Za-z0-9._-]{8,}/gi,
  /(Key\s+)[A-Za-z0-9:._-]{8,}/g,
  /("?(?:api[_-]?key|token|authorization|x-api-key|xi-api-key)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
];

const registered = new Set<string>();

/** Register a concrete secret value so it is always masked in logs. */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 6) registered.add(value);
}

export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : input instanceof Error ? `${input.name}: ${input.message}` : safeJson(input);
  for (const secret of registered) s = s.split(secret).join('[REDACTED]');
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (_m, prefix: string) => (prefix && /^(Bearer|Key|"?(api|token|auth|x-|xi-))/i.test(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return s;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

type Level = 'debug' | 'info' | 'warn' | 'error';
let quiet = process.env.VOIDCRAFT_QUIET === '1';
export function setQuiet(q: boolean): void {
  quiet = q;
}

function write(level: Level, msg: string, extra?: unknown): void {
  if (quiet && level !== 'error') return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${redact(msg)}${extra === undefined ? '' : ' ' + redact(extra)}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, e?: unknown) => process.env.VOIDCRAFT_DEBUG && write('debug', m, e),
  info: (m: string, e?: unknown) => write('info', m, e),
  warn: (m: string, e?: unknown) => write('warn', m, e),
  error: (m: string, e?: unknown) => write('error', m, e),
};
