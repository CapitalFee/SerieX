// Promise-based message boxes rendered in a top layer by <DialogHost/> (App mounts it once).
//
//   const r = await msgBox({ title: 'Unsaved Changes', message: '...', buttons: ['&Save', "&Don't Save", 'Cancel'], icon: 'question' });
//   await alertBox('You must select a customer.', 'Warning');
//   if (await confirmBox('Delete this line?')) ...
//   const pw = await promptBox('Enter the closing date password', { password: true });
//   const v = await showDialog<string | null>({ title: 'Select Name Type', render: (close) => <MyForm onDone={close} /> });
//
// Keyboard: Enter = default (first) button, Escape = Cancel (or No / OK), arrows move between
// buttons, the first letter of a button label chooses it. Focus returns to where it was.
// The API client's server questions (confirm / closing date password) are wired here at load time.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { setPromptHandlers } from '@/api/client';
import { DIALOG_ASIDE_CLASS, DIALOG_LAYER_CLASS, Z_DIALOG, setDialogAsideHooks } from './layers';
import { tabbables } from './focus';
import { ContextMenuHost } from './menu';
import { parseAccessLabel } from './accessLabel';

/** Icon of a message box. */
export type MsgIcon = 'question' | 'warning' | 'error' | 'info';

/** Options of {@link msgBox}. */
export interface MsgBoxOptions {
  /** Title bar text (default depends on the icon). */
  title?: string;
  /** Message; "\n" starts a new line. */
  message: string;
  /** Button labels, left to right (default ['OK']). `&` marks an access key ("&Add Name Only"). */
  buttons?: string[];
  icon?: MsgIcon;
  /** Label of the button chosen by Enter (default: the first). */
  defaultButton?: string;
  /** Label returned by Escape / the close box (default: Cancel, else the only button, else No). */
  cancelButton?: string;
  /** Box width in px (default automatic, 300-480; a given width may exceed the 620px cap, up to 96vw). */
  width?: number;
}

interface Entry {
  id: number;
  title: string;
  width?: number;
  role: 'alertdialog' | 'dialog';
  render: (close: (v: unknown) => void) => ReactNode;
  cancel: () => void;
  close: (v: unknown) => void;
  /** Windows this box stepped aside for (hidden while one of them is open). */
  aside: string[];
  /** Element that had the focus when the box stepped aside (focused again when it comes back). */
  focusBefore?: HTMLElement | null;
  /** The grid that element was in (a grid cell editor is gone when the box comes back). */
  focusGrid?: HTMLElement | null;
}

let seq = 0;
let stack: Entry[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// --- host ownership: the most recently mounted DialogHost renders; a fallback host is
// created on demand when a box is requested before the App mounted one.
let hostOwners: number[] = [];
let hostSeq = 0;
let fallbackMounted = false;
const ownerListeners = new Set<() => void>();

function ensureHost() {
  if (hostOwners.length > 0 || fallbackMounted || typeof document === 'undefined') return;
  fallbackMounted = true;
  const div = document.createElement('div');
  div.setAttribute('data-sx-dialog-fallback', '');
  document.body.appendChild(div);
  createRoot(div).render(<DialogHost />);
}

function push<T>(opts: { title: string; width?: number; role?: 'alertdialog' | 'dialog'; cancelValue: T; render: (close: (v: T) => void) => ReactNode }): Promise<T> {
  ensureHost();
  return new Promise<T>((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const id = ++seq;
    let done = false;
    const close = (v: unknown) => {
      if (done) return;
      done = true;
      stack = stack.filter((e) => e.id !== id);
      emit();
      if (prevFocus && prevFocus.isConnected && prevFocus !== document.body) {
        try {
          prevFocus.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }
      resolve(v as T);
    };
    stack = [
      ...stack,
      {
        id,
        title: opts.title,
        width: opts.width,
        role: opts.role ?? 'dialog',
        render: opts.render as (close: (v: unknown) => void) => ReactNode,
        cancel: () => close(opts.cancelValue),
        close,
        aside: [],
      },
    ];
    emit();
  });
}

// A window opened while boxes are on screen (e.g. "+ Add new" in a picker of a showDialog() box
// opens the payroll item wizard): the boxes step aside until that window closes (layers.ts).
setDialogAsideHooks({
  stepAside(windowId) {
    if (!stack.length) return false;
    const ae = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const grid = ae?.closest<HTMLElement>('.sx-grid') ?? null;
    stack = stack.map((e) => {
      if (e.aside.includes(windowId)) return e;
      if (e.aside.length) return { ...e, aside: [...e.aside, windowId] };
      return { ...e, aside: [windowId], focusBefore: ae, focusGrid: grid };
    });
    emit();
    return true;
  },
  comeBack(windowId) {
    if (!stack.some((e) => e.aside.includes(windowId))) return;
    stack = stack.map((e) => (e.aside.includes(windowId) ? { ...e, aside: e.aside.filter((w) => w !== windowId) } : e));
    emit();
  },
});

/** Number of message boxes / dialogs currently open (also the ones that stepped aside for a window). */
export function openDialogCount(): number {
  return stack.length;
}

// ---------------------------------------------------------------------------
// Public API

/** Shows a message box and resolves with the label of the chosen button (without `&`). */
export function msgBox(opts: MsgBoxOptions): Promise<string> {
  const buttons = (opts.buttons && opts.buttons.length ? opts.buttons : ['OK']).map((b) => b);
  const plain = buttons.map((b) => parseAccessLabel(b).text);
  const icon = opts.icon ?? 'info';
  const cancel =
    opts.cancelButton ?? (plain.includes('Cancel') ? 'Cancel' : plain.length === 1 ? plain[0] : plain.includes('No') ? 'No' : plain[plain.length - 1]);
  const title = opts.title ?? (icon === 'error' ? 'Error' : icon === 'warning' ? 'Warning' : 'SerieX Payroll');
  return push<string>({
    title,
    width: opts.width,
    role: 'alertdialog',
    cancelValue: cancel,
    render: (close) => (
      <MessageBoxBody
        message={opts.message}
        icon={icon}
        buttons={buttons}
        defaultButton={opts.defaultButton ?? plain[0]}
        cancelButton={cancel}
        onResult={close}
      />
    ),
  });
}

/** Information/warning box with an OK button. The icon follows the title ("Error", "Warning") unless given. */
export async function alertBox(message: string, title?: string, icon?: MsgIcon): Promise<void> {
  const ic: MsgIcon = icon ?? (title && /error/i.test(title) ? 'error' : title && /warn/i.test(title) ? 'warning' : 'info');
  await msgBox({ title, message, buttons: ['OK'], icon: ic });
}

/** Yes/No question; resolves true on Yes. */
export async function confirmBox(message: string, title?: string): Promise<boolean> {
  return (await msgBox({ title: title ?? 'SerieX Payroll', message, buttons: ['Yes', 'No'], icon: 'question' })) === 'Yes';
}

/** Text (or password) prompt; resolves with the text, or null on Cancel. */
export function promptBox(message: string, opts: { password?: boolean; defaultValue?: string; title?: string } = {}): Promise<string | null> {
  return push<string | null>({
    title: opts.title ?? (opts.password ? 'Password Required' : 'SerieX Payroll'),
    cancelValue: null,
    render: (close) => <PromptBody message={message} password={!!opts.password} defaultValue={opts.defaultValue ?? ''} onResult={close} />,
  });
}

/** One option of {@link choiceBox}. */
export interface Choice {
  value: string;
  label: string;
}

/**
 * Radio-button choice box (e.g. "Select Name Type": Customer / Vendor / Other).
 * Resolves with the chosen value, or null on Cancel.
 */
export function choiceBox(opts: { title: string; message?: string; choices: Choice[]; defaultValue?: string }): Promise<string | null> {
  return push<string | null>({
    title: opts.title,
    cancelValue: null,
    render: (close) => <ChoiceBody message={opts.message} choices={opts.choices} defaultValue={opts.defaultValue ?? opts.choices[0]?.value} onResult={close} />,
  });
}

/** Options of {@link showDialog}. */
export interface ShowDialogOptions<T> {
  title: string;
  /**
   * Box width in px (default automatic, at most 620px). A given width is used as is, up to 96% of
   * the browser window (e.g. 820 for selection dialogs with a table).
   */
  width?: number;
  /** Value resolved by Escape / the close box. */
  cancelValue: T;
  /** Renders the content; call `close(value)` to close and resolve. */
  render: (close: (value: T) => void) => ReactNode;
}

/**
 * Shows any content in a modal top-layer box with a title bar (drag to move).
 * Escape (when not handled by the content) and the close box resolve `cancelValue`.
 * Use `<div className="sx-dlg-buttons">` for a standard button row.
 */
export function showDialog<T>(opts: ShowDialogOptions<T>): Promise<T> {
  return push<T>({ title: opts.title, width: opts.width, cancelValue: opts.cancelValue, render: opts.render });
}

/** Renders the open message boxes and the imperative context menu. Mount once (App does). */
export function DialogHost() {
  const [me] = useState(() => ++hostSeq);
  const [, force] = useState(0);
  useLayoutEffect(() => {
    hostOwners.push(me);
    const l = () => force((n) => n + 1);
    ownerListeners.add(l);
    ownerListeners.forEach((x) => x());
    return () => {
      hostOwners = hostOwners.filter((h) => h !== me);
      ownerListeners.delete(l);
      ownerListeners.forEach((x) => x());
    };
  }, [me]);
  const entries = useSyncExternalStore(subscribe, () => stack);
  const isOwner = hostOwners[hostOwners.length - 1] === me;
  if (!isOwner) return null;
  return createPortal(
    <div className={DIALOG_LAYER_CLASS}>
      <ContextMenuHost />
      {entries.map((e, i) => (
        <DialogFrame key={e.id} entry={e} z={Z_DIALOG + i * 2} />
      ))}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Frame (title bar, drag, focus trap) shared by every box

function DialogFrame({ entry, z }: { entry: Entry; z: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [flash, setFlash] = useState(false);
  const titleId = `sx-dlg-title-${entry.id}`;

  useEffect(() => {
    // focus the first focusable element when the body did not focus something itself
    const t = setTimeout(() => {
      const box = boxRef.current;
      if (box && !box.contains(document.activeElement)) (tabbables(box)[0] ?? box).focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Back from stepping aside for a window: the keyboard returns to the box (the grid cell a
  // picker re-activated, else the field that had the focus, the grid it was in, or the first field).
  const aside = entry.aside.length > 0;
  const wasAside = useRef(false);
  useEffect(() => {
    if (aside) {
      wasAside.current = true;
      return;
    }
    if (!wasAside.current) return;
    wasAside.current = false;
    const t = setTimeout(() => {
      const box = boxRef.current;
      if (!box || box.contains(document.activeElement)) return;
      const inBox = (el: HTMLElement | null | undefined) => (el && el.isConnected && box.contains(el) ? el : null);
      const cell = (inBox(entry.focusGrid) ?? box).querySelector<HTMLElement>('.sx-grid-cell.sx-active');
      const target = (cell && tabbables(cell)[0]) || inBox(entry.focusBefore) || inBox(entry.focusGrid) || tabbables(box)[0] || box;
      try {
        target.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }, 0);
    return () => clearTimeout(t);
  }, [aside, entry.focusBefore, entry.focusGrid]);

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const sx = e.clientX - off.x;
    const sy = e.clientY - off.y;
    const move = (ev: MouseEvent) => setOff({ x: ev.clientX - sx, y: Math.max(-window.innerHeight / 2 + 20, ev.clientY - sy) });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      className={'sx-dlg-overlay' + (aside ? ' ' + DIALOG_ASIDE_CLASS : '')}
      style={{ zIndex: z }}
      aria-hidden={aside || undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          setFlash(true);
          setTimeout(() => setFlash(false), 300);
        }
      }}
    >
      <div
        ref={boxRef}
        className={'sx-dlg-box' + (flash ? ' sx-flash' : '')}
        role={entry.role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          width: entry.width,
          // an explicit width may go beyond the default 620px cap (selection dialogs with tables)
          maxWidth: entry.width ? `min(${entry.width}px, 96vw)` : undefined,
          transform: `translate(${off.x}px, ${off.y}px)`,
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            entry.cancel();
          } else if (e.key === 'Tab') {
            const list = tabbables(boxRef.current!);
            if (list.length) {
              const i = list.indexOf(document.activeElement as HTMLElement);
              const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : i < 0 || i >= list.length - 1 ? 0 : i + 1;
              list[next].focus();
              e.preventDefault();
            }
          }
          // keys typed in a box never reach the application behind it
          e.stopPropagation();
        }}
      >
        <div className="sx-dlg-title" onMouseDown={startDrag}>
          <span className="sx-dlg-title-icon" aria-hidden="true" />
          <span id={titleId} className="sx-dlg-title-text">
            {entry.title}
          </span>
          <button type="button" className="sx-dlg-close" aria-label="Close" tabIndex={-1} onClick={() => entry.cancel()}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {entry.render(entry.close)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bodies

/** Message box icon (32px): a soft colored circle with a symbol. */
export function MsgBoxIcon({ icon, size = 32 }: { icon: MsgIcon; size?: number }) {
  const c = {
    warning: { bg: '#fdf1dc', fg: '#d97706' },
    error: { bg: '#fde8e8', fg: '#dc2626' },
    question: { bg: '#e5eefd', fg: '#2563eb' },
    info: { bg: '#e5eefd', fg: '#2563eb' },
  }[icon] ?? { bg: '#e5eefd', fg: '#2563eb' };
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill={c.bg} />
      {icon === 'warning' && (
        <>
          <path d="M16 8.5 L24.5 23 H7.5 Z" fill="none" stroke={c.fg} strokeWidth="2" strokeLinejoin="round" />
          <path d="M16 13.5 V17.5" stroke={c.fg} strokeWidth="2" strokeLinecap="round" />
          <circle cx="16" cy="20.3" r="1.2" fill={c.fg} />
        </>
      )}
      {icon === 'error' && <path d="M11.5 11.5 L20.5 20.5 M20.5 11.5 L11.5 20.5" stroke={c.fg} strokeWidth="2.4" strokeLinecap="round" />}
      {icon === 'question' && (
        <>
          <path d="M12.6 12.8 C12.6 10.6 14.2 9.3 16.2 9.3 C18.3 9.3 19.8 10.6 19.8 12.5 C19.8 15 16.5 15.3 16.5 18.2" fill="none" stroke={c.fg} strokeWidth="2.3" strokeLinecap="round" />
          <circle cx="16.5" cy="22.4" r="1.5" fill={c.fg} />
        </>
      )}
      {icon === 'info' && (
        <>
          <circle cx="16" cy="10.4" r="1.6" fill={c.fg} />
          <path d="M16 14.5 V22" stroke={c.fg} strokeWidth="2.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

function MessageBoxBody(props: {
  message: string;
  icon: MsgIcon;
  buttons: string[];
  defaultButton: string;
  cancelButton: string;
  onResult: (v: string) => void;
}) {
  const { message, icon, buttons, defaultButton, onResult } = props;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const parsed = buttons.map((b) => parseAccessLabel(b));
  const defIdx = Math.max(0, parsed.findIndex((p) => p.text === defaultButton));
  useEffect(() => {
    refs.current[defIdx]?.focus();
  }, [defIdx]);
  return (
    <div
      onKeyDown={(e) => {
        const i = refs.current.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          refs.current[(i + 1) % buttons.length]?.focus();
          e.preventDefault();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          refs.current[(i - 1 + buttons.length) % buttons.length]?.focus();
          e.preventDefault();
        } else if (!e.ctrlKey && !e.metaKey && (/^Key[A-Z]$/.test(e.code) || (e.key.length === 1 && /[a-z]/i.test(e.key)))) {
          // the letter comes from the physical key so Alt+letter also works on macOS
          const k = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
          const idx = parsed.findIndex((p) => p.key === k);
          const j = idx >= 0 ? idx : parsed.findIndex((p) => p.text.toLowerCase().startsWith(k));
          if (j >= 0) {
            e.preventDefault();
            onResult(parsed[j].text);
          }
        }
      }}
    >
      <div className="sx-msgbox-body">
        <div className="sx-msgbox-icon">
          <MsgBoxIcon icon={icon} />
        </div>
        <div className="sx-msgbox-text">{message}</div>
      </div>
      <div className="sx-dlg-buttons sx-center">
        {parsed.map((p, i) => (
          <button
            key={i}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            className={'sx-btn ' + (i === defIdx ? 'sx-btn-primary' : 'sx-btn-secondary')}
            onClick={() => onResult(p.text)}
          >
            <span className="sx-btn-text">{p.node}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PromptBody(props: { message: string; password: boolean; defaultValue: string; onResult: (v: string | null) => void }) {
  const [v, setV] = useState(props.defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.onResult(v);
      }}
    >
      <div className="sx-msgbox-body">
        <div className="sx-msgbox-icon">
          <MsgBoxIcon icon={props.password ? 'warning' : 'question'} />
        </div>
        <div className="sx-prompt-main">
          <div className="sx-msgbox-text">{props.message}</div>
          <input
            ref={inputRef}
            className="sx-input sx-prompt-input"
            type={props.password ? 'password' : 'text'}
            value={v}
            autoComplete={props.password ? 'current-password' : 'off'}
            aria-label={props.message}
            onChange={(e) => setV(e.target.value)}
          />
        </div>
      </div>
      <div className="sx-dlg-buttons sx-center">
        <button type="submit" className="sx-btn sx-btn-primary">
          OK
        </button>
        <button type="button" className="sx-btn sx-btn-secondary" onClick={() => props.onResult(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ChoiceBody(props: { message?: string; choices: Choice[]; defaultValue?: string; onResult: (v: string | null) => void }) {
  const [v, setV] = useState(props.defaultValue ?? '');
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.onResult(v);
      }}
    >
      <div className="sx-choice-body">
        {props.message && <div className="sx-msgbox-text sx-choice-msg">{props.message}</div>}
        <div role="radiogroup" className="sx-choice-list">
          {props.choices.map((c) => (
            <label key={c.value} className="sx-radio">
              <input
                ref={c.value === v ? firstRef : undefined}
                type="radio"
                name="sx-choice"
                checked={c.value === v}
                onChange={() => setV(c.value)}
                onDoubleClick={() => props.onResult(c.value)}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="sx-dlg-buttons sx-center">
        <button type="submit" className="sx-btn sx-btn-primary">
          OK
        </button>
        <button type="button" className="sx-btn sx-btn-secondary" onClick={() => props.onResult(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Server questions from the API client (confirm → Yes/No box, closing date → password)

setPromptHandlers({
  confirm: async (message, title) => (await msgBox({ title: title ?? 'Warning', message, buttons: ['Yes', 'No'], icon: 'warning' })) === 'Yes',
  password: (message, title) => promptBox(message, { password: true, title: title ?? 'Closing Date Password' }),
});
