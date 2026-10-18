import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X, AlertTriangle, Info, CheckCircle2, XCircle } from 'lucide-react';

export function Field({ label, hint, children, disabled, right }: { label: ReactNode; hint?: ReactNode; children: ReactNode; disabled?: boolean; right?: ReactNode }) {
  const labelId = useId();
  const ref = useRef<HTMLDivElement>(null);
  // Associate the label with the first form control so screen readers (and tests) can find it.
  useEffect(() => {
    const control = ref.current?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, [role=radiogroup]');
    if (control && !control.getAttribute('aria-label') && !control.getAttribute('aria-labelledby')) control.setAttribute('aria-labelledby', labelId);
  });
  return (
    <div className={`field${disabled ? ' disabled' : ''}`} ref={ref}>
      <div className="field-label">
        <span className="grow" id={labelId}>{label}</span>
        {right}
      </div>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  onCommit,
  disabled,
  label,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  disabled?: boolean;
  label?: string;
  format?: (v: number) => string;
}) {
  const id = useId();
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (format ? format(value) : String(Math.round(value * 1000) / 1000));
  return (
    <div className="slider">
      <input
        id={id}
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      <input
        className="input"
        aria-label={label ? `${label} value` : undefined}
        value={shown}
        disabled={disabled}
        onFocus={() => setText(String(Math.round(value * 1000) / 1000))}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Number(text);
          if (text !== null && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
          setText(null);
          onCommit?.();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
    </div>
  );
}

export function Select<T extends string>({ value, onChange, options, disabled, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string; disabled?: boolean }>; disabled?: boolean; label?: string }) {
  return (
    <select className="select" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Seg<T extends string | number>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode; disabled?: boolean; title?: string }>; label?: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="check" style={disabled ? { opacity: 0.5 } : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" data-close aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'err' | 'ok' | 'accent'; children: ReactNode }) {
  const Icon = kind === 'warn' ? AlertTriangle : kind === 'err' ? XCircle : kind === 'ok' ? CheckCircle2 : Info;
  return (
    <div className={`notice ${kind === 'info' ? '' : kind}`} role={kind === 'err' ? 'alert' : undefined}>
      <Icon size={15} />
      <div className="grow">{children}</div>
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div style={{ color: 'var(--text-1)', fontWeight: 550 }}>{title}</div>
      {children && <div className="small" style={{ maxWidth: 420 }}>{children}</div>}
      {action}
    </div>
  );
}

export function Progress({ value }: { value: number | null }) {
  return (
    <div className={`progress${value === null ? ' indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)}>
      <div style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: ReactNode }> }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={t.value === value} className={`tab${t.value === value ? ' on' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function ColorSwatches({ colors, onChange, max = 8 }: { colors: string[]; onChange: (c: string[]) => void; max?: number }) {
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {colors.map((c, i) => (
        <div key={i} className="swatch" style={{ background: c }} title={`${c} — click to change, right-click to remove`} onContextMenu={(e) => {
          e.preventDefault();
          onChange(colors.filter((_, j) => j !== i));
        }}>
          <input type="color" aria-label={`Palette color ${i + 1}`} value={c} onChange={(e) => onChange(colors.map((x, j) => (j === i ? e.target.value : x)))} />
        </div>
      ))}
      {colors.length < max && (
        <button className="btn sm ghost" type="button" onClick={() => onChange([...colors, '#8b5cf6'])}>
          + Color
        </button>
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const cls = status === 'succeeded' || status === 'done' || status === 'approved' ? 'ok' : status === 'failed' || status === 'rejected' ? 'err' : status === 'canceled' ? '' : status === 'draft' || status === 'unreviewed' ? '' : 'accent';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function ProvenanceBadge({ ai, generator }: { ai: boolean; generator?: string | null }) {
  return ai ? (
    <span className="badge accent" title={generator ?? undefined}>
      AI · {generator?.split('/')[0] ?? 'model'}
    </span>
  ) : generator ? (
    <span className="badge warn" title={generator}>
      Not AI
    </span>
  ) : null;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function formatDuration(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return m > 0 ? `${m}:${sec.toFixed(0).padStart(2, '0')}` : `${sec.toFixed(1)}s`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
