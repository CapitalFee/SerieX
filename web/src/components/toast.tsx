// Non-blocking toast notifications ("Invoice 1042 saved").
// The shell mounts <ToastHost/> once; any module calls toast(...).
//
//   toast('Invoice 1042 saved', { action: { label: 'Open', onClick: () => openTxn('INV', 12) } });
//   toast('Could not reach the server', { kind: 'error', duration: 8000 });
// Hovering a toast keeps it on screen; it disappears after `duration` ms otherwise.
// Toasts never cover the buttons of a message box or modal dialog, or the Save bar of the active
// window: they sit at the bottom right, else move to the first free corner (top right, bottom
// left, top left), re-checked while they are shown.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
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

/** Controls a toast must not cover: message boxes, modal dialogs, the active window's Save bar. */
const GUARDED = [
  '.sx-dlg-overlay button',
  '.sx-dlg-overlay input',
  '.sx-dlg-overlay select',
  '.sx-win-modal button',
  '.sx-win-modal input',
  '.sx-win-modal select',
  '.sx-win-active .sx-txnform-sticky button',
  '.sx-win-active .sx-editdlg-foot button',
  '.sx-win-active .sx-dlg-buttons button',
].join(', ');
const GAP = 18;
/** Where the toasts may sit, in order of preference. */
type Spot = 'br' | 'tr' | 'bl' | 'tl';
const SPOTS: Spot[] = ['br', 'tr', 'bl', 'tl'];
const BOTTOM = 72; // above the sticky Save bars of forms and dialogs

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Top of the toasts when they sit at the top: just below the menu and tool bars. */
function topOffset(): number {
  const d = document.querySelector('.sx-desktop')?.getBoundingClientRect();
  return Math.max(8, Math.round((d?.top ?? 56) + 8));
}

function spotBox(spot: Spot, w: number, h: number): Box {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = spot === 'br' || spot === 'tr' ? vw - GAP - w : GAP;
  const top = spot === 'br' || spot === 'bl' ? vh - BOTTOM - h : topOffset();
  return { left, top, right: left + w, bottom: top + h };
}

function spotStyle(spot: Spot): CSSProperties | undefined {
  if (spot === 'br') return undefined; // the stylesheet position
  const right = spot === 'tr';
  const top = spot === 'tr' || spot === 'tl';
  return {
    left: right ? 'auto' : GAP,
    right: right ? GAP : 'auto',
    top: top ? topOffset() : 'auto',
    bottom: top ? 'auto' : BOTTOM,
    alignItems: right ? 'flex-end' : 'flex-start',
  };
}

/** Area of `b` covered by the guarded controls (with a small margin). */
function coveredArea(b: Box, guards: Box[]): number {
  let a = 0;
  for (const g of guards) {
    const w = Math.min(b.right, g.right + 4) - Math.max(b.left, g.left - 4);
    const h = Math.min(b.bottom, g.bottom + 4) - Math.max(b.top, g.top - 4);
    if (w > 0 && h > 0) a += w * h;
  }
  return a;
}

/** The first spot where the toasts cover no guarded control (else the one covering the least). */
function bestSpot(host: HTMLElement): Spot {
  const guards: Box[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(GUARDED)) {
    if (!el.offsetWidth || !el.offsetHeight) continue;
    const r = el.getBoundingClientRect();
    guards.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  if (!guards.length) return 'br';
  const w = host.offsetWidth;
  const h = host.offsetHeight;
  let best: Spot = 'br';
  let bestArea = Infinity;
  for (const s of SPOTS) {
    const a = coveredArea(spotBox(s, w, h), guards);
    if (a === 0) return s;
    if (a < bestArea) {
      best = s;
      bestArea = a;
    }
  }
  return best;
}

/** Mount once near the root of the app. */
export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);
  const [spot, setSpot] = useState<Spot>('br');
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listeners.add(setList);
    setList(items);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  // keep the toasts off dialog buttons: check when they change and while they are shown
  // (a dialog may open, move or close meanwhile)
  const visible = list.length > 0;
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const host = hostRef.current;
      if (host) setSpot(bestSpot(host));
    };
    place();
    const t = window.setInterval(place, 250);
    window.addEventListener('resize', place);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('resize', place);
    };
  }, [visible, list]);
  if (!list.length) return null;
  return (
    <div ref={hostRef} className="sx-toast-host" style={spotStyle(spot)} data-spot={spot} aria-live="polite">
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
