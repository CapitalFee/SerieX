// Non-blocking toast notifications ("Invoice 1042 saved").
// The shell mounts <ToastHost/> once; any module calls toast(...).
//
//   toast('Invoice 1042 saved', { action: { label: 'Open', onClick: () => openTxn('INV', 12) } });
//   toast('Could not reach the server', { kind: 'error', duration: 8000 });
// Hovering a toast keeps it on screen; it disappears after `duration` ms otherwise.
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

export interface ToastOptions {
  kind?: 'success' | 'info' | 'warning' | 'error';
  /** Optional action button, e.g. { label: 'Open', onClick: () => openTxn('INV', 12) } */
  action?: { label: string; onClick: () => void };
  /** Milliseconds before it disappears (default 4000; 6000 when it has an action). */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
}

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<(items: ToastItem[]) => void>();
const timers = new Map<number, number>();
const MAX_VISIBLE = 4;

function emit() {
  listeners.forEach((fn) => fn(items));
}

function arm(id: number, ms: number) {
  window.clearTimeout(timers.get(id));
  timers.set(
    id,
    window.setTimeout(() => dismissToast(id), ms),
  );
}

/** Show a toast message. Returns its id. */
export function toast(message: string, opts: ToastOptions = {}): number {
  const id = ++seq;
  const item: ToastItem = { id, message, kind: 'success', ...opts };
  items = [...items, item].slice(-MAX_VISIBLE);
  emit();
  arm(id, opts.duration ?? (opts.action ? 6000 : 4000));
  return id;
}

export function dismissToast(id: number): void {
  window.clearTimeout(timers.get(id));
  timers.delete(id);
  items = items.filter((t) => t.id !== id);
  emit();
}

const ICONS = { success: CheckCircle2, info: Info, warning: AlertTriangle, error: XCircle } as const;

/** Mount once near the root of the app. */
export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    setList(items);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  if (!list.length) return null;
  return (
    <div className="sx-toast-host" aria-live="polite">
      {list.map((t) => {
        const kind = t.kind ?? 'success';
        const Icon = ICONS[kind];
        return (
          <div
            key={t.id}
            className={`sx-toast sx-toast-${kind}`}
            role={kind === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => window.clearTimeout(timers.get(t.id))}
            onMouseLeave={() => arm(t.id, 2500)}
          >
            <Icon size={18} className="sx-toast-icon" aria-hidden="true" />
            <span className="sx-toast-msg">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="sx-toast-action"
                onClick={() => {
                  t.action!.onClick();
                  dismissToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="sx-toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
