// One window: in the Tabs workspace a document window is a full-size page (its tab
// is in the tab strip); otherwise (floating windows, and dialogs in both modes) it
// has a title bar, buttons, drag and resize handles. Also the error boundary and
// the lazy window content with its WindowContext.
import { Component, memo, Suspense, useEffect, useMemo, useRef, type ErrorInfo, type ReactNode } from 'react';
import { WindowContext, type WindowApi } from '@/windows/WindowContext';
import { windowComponent } from '@/windows/registry';
import type { WindowKind } from '@/windows/kinds';
import {
  useWindowStore,
  closeWindow,
  focusWindow,
  minimizeWindow,
  toggleMaximize,
  moveWindow,
  resizeWindow,
  setWindowTitle,
  setWindowDirty,
  setBeforeClose,
  setWindowKeyProps,
  setWindowProps,
  getCurrentTabId,
  minimizedStripHeight,
} from '@/windows/windowStore';
import { useView } from '@/state/view';
import { tabbables } from '@/components/focus';
import { GlyphClose, GlyphMax, GlyphMin, GlyphRestore } from './glyphs';
import { kindIcon } from './kindIcons';

/** z-index layers inside the desktop: document windows < modal overlay < modal dialogs. */
export const MODAL_LAYER = 1_000_000;
export function zIndexOf(w: { z: number; modal: boolean }): number {
  return (w.modal ? MODAL_LAYER : 0) + w.z * 2;
}

const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Dir = (typeof DIRS)[number];

/** Elements that take the keyboard focus themselves when clicked (a click there needs no help). */
const CLICK_FOCUSES =
  'input, select, textarea, button, a[href], label, [contenteditable=""], [contenteditable="true"], [tabindex], [role="grid"], [role="row"], [role="gridcell"], [role="option"], [role="listbox"], [role="tab"], [role="treeitem"]';
/** A window opened less than this ago (ms) and never focused inside chooses its first field itself. */
const NEW_WINDOW_MS = 2000;
/** How long (ms) a focus request keeps trying while the window's content is still loading. */
const RETRY_MS = 8000;
/** Fields preferred when a window has no control focused before (its first field). */
const FIELDS = 'input, select, textarea, [role="combobox"], [role="grid"], [contenteditable="true"]';

function canFocus(el: HTMLElement | null, root: HTMLElement): el is HTMLElement {
  if (!el || !el.isConnected || el === root || !root.contains(el)) return false;
  if ((el as HTMLInputElement).disabled || el.closest('[inert], [aria-hidden="true"]')) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

/** True when `el` is in the content of the window `root` (not its title bar). */
function inContent(el: Element | null | undefined, root: HTMLElement): boolean {
  return !!el && el.closest('.sx-win-body')?.parentElement === root;
}

/** Puts the keyboard focus on `el`; true when it took it. */
function tryFocus(el: HTMLElement): boolean {
  el.focus({ preventScroll: true });
  const ae = document.activeElement;
  return !!ae && (ae === el || el.contains(ae));
}

/** Message boxes, drop-downs and popovers live outside the frame: they keep the focus. */
function focusIsElsewhere(ae: Element | null, root: HTMLElement): boolean {
  if (!ae || ae === document.body || ae === root || root.contains(ae)) return false;
  return !ae.closest('.sx-frame') || !!ae.closest('.sx-dlg-layer, .sx-popup, .sx-pop');
}

export const MdiWindow = memo(function MdiWindow({ id }: { id: string }) {
  const w = useWindowStore((s) => s.windows.find((v) => v.id === id));
  const active = useWindowStore((s) => s.activeId === id);
  const oneMode = useView((s) => s.windowMode === 'one');
  const currentTab = useWindowStore((s) => oneMode && getCurrentTabId(s) === id);
  // floating: a maximized window ends above the minimized title bars
  const minStrip = useWindowStore((s) => minimizedStripHeight(s, oneMode));
  // number of the latest request to put the keyboard focus inside this window (0: none)
  const focusReq = useWindowStore((s) => (s.focusReq.id === id ? s.focusReq.n : 0));
  const rootRef = useRef<HTMLDivElement>(null);
  /** Control focused last inside the window, and its nearest focusable container (e.g. a grid). */
  const lastFocus = useRef<HTMLElement | null>(null);
  const lastHolder = useRef<HTMLElement | null>(null);
  const mountedAt = useRef(performance.now());
  /** Focus request already carried out (each request moves the focus once). */
  const doneReq = useRef(0);

  const kind = w?.kind;
  const props = w?.props;
  const api = useMemo<WindowApi | null>(
    () =>
      kind && props
        ? {
            id,
            kind,
            props,
            close: (force?: boolean) => closeWindow(id, { force }),
            setTitle: (t: string) => setWindowTitle(id, t),
            setDirty: (d: boolean) => setWindowDirty(id, d),
            setBeforeClose: (fn: (() => Promise<boolean>) | null) => setBeforeClose(id, fn),
            focus: () => focusWindow(id),
            isActive: active,
            setKeyProps: (p: Record<string, any>) => setWindowKeyProps(id, p),
            setProps: (p: Record<string, any>) => setWindowProps(id, p),
          }
        : null,
    [id, kind, props, active],
  );

  // Keyboard focus follows the active window.
  const minimized = !!w?.minimized;
  useEffect(() => {
    if (!active || minimized) return;
    const root = rootRef.current;
    if (!root) return;
    const ae = document.activeElement;
    if (ae && root.contains(ae)) return;
    // Do not steal focus from message boxes / popups rendered outside the frame.
    if (ae && ae !== document.body && !ae.closest('.sx-frame')) return;
    root.focus({ preventScroll: true });
  }, [active, minimized]);

  // Focused or brought to the front (menus, + New, tabs, Window list, minimized title bar, the
  // window above it closed): the focus goes back to the control focused there last, else to
  // its first field, so typing goes into the window (not to the global search box). It runs
  // after the click or key that asked for it is over, and leaves alone a control that already
  // has the focus inside the window and message boxes / drop-downs open outside it.
  useEffect(() => {
    if (!focusReq || focusReq === doneReq.current) return;
    let t = 0;
    const started = performance.now();
    /** One try; true when done (the focus is placed, or it is not this window's to move). */
    const attempt = (retry: boolean): boolean => {
      const root = rootRef.current;
      const s = useWindowStore.getState();
      if (!root || s.activeId !== id || s.windows.find((v) => v.id === id)?.minimized) return true;
      const ae = document.activeElement;
      if (inContent(ae, root)) return true;
      if (focusIsElsewhere(ae, root)) return true;
      // a later try only moves the focus off the frame (the user may have clicked elsewhere since)
      if (retry && ae && ae !== root && ae !== document.body) return true;
      if (canFocus(lastFocus.current, root) && tryFocus(lastFocus.current)) return true;
      if (canFocus(lastHolder.current, root) && tryFocus(lastHolder.current)) return true;
      const now = performance.now();
      // a window that just opened puts the cursor in its first field itself (once its data is
      // in): the frame holds the keyboard meanwhile, and the next tries check it did
      const waiting = !lastFocus.current && now - mountedAt.current < NEW_WINDOW_MS;
      const body = root.querySelector<HTMLElement>(':scope > .sx-win-body') ?? root;
      const list = waiting ? [] : tabbables(body).filter((el) => canFocus(el, root));
      const first = list.find((el) => el.matches(FIELDS)) ?? list[0];
      if (first && tryFocus(first)) return true;
      if (document.activeElement !== root) root.focus({ preventScroll: true });
      // keep trying while the window may still pick its field or its content is still loading
      return !waiting && now - started > RETRY_MS;
    };
    let tries = 0;
    const run = () => {
      doneReq.current = focusReq;
      if (!attempt(tries++ > 0)) t = window.setTimeout(run, 100);
    };
    t = window.setTimeout(run, 0);
    return () => window.clearTimeout(t);
  }, [focusReq, id]);

  if (!w || !api) return null;
  const asTab = oneMode && !w.modal;
  const maximized = (w.maximized && !w.modal) || asTab;

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest('.sx-wbtn')) return;
    focusWindow(id);
    if (maximized) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = w.x;
    const oy = w.y;
    document.body.classList.add('sx-dragging');
    const move = (ev: PointerEvent) => moveWindow(id, ox + ev.clientX - sx, oy + ev.clientY - sy);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('sx-dragging');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const startResize = (dir: Dir) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    focusWindow(id);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const start = { x: w.x, y: w.y, w: w.w, h: w.h };
    document.body.classList.add('sx-dragging', `sx-resizing-${dir}`);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      let { x, y, w: ww, h } = start;
      if (dir.includes('e')) ww = Math.max(w.minW, start.w + dx);
      if (dir.includes('s')) h = Math.max(w.minH, start.h + dy);
      if (dir.includes('w')) {
        ww = Math.max(w.minW, start.w - dx);
        x = start.x + start.w - ww;
      }
      if (dir.includes('n')) {
        h = Math.max(w.minH, start.h - dy);
        y = start.y + start.h - h;
        if (y < 0) {
          h += y;
          y = 0;
        }
      }
      resizeWindow(id, { x, y, w: ww, h });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('sx-dragging', `sx-resizing-${dir}`);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const cls = [
    'sx-win',
    active ? 'sx-win-active' : 'sx-win-inactive',
    asTab ? 'sx-win-tab' : maximized ? 'sx-win-max' : '',
    asTab && !currentTab ? 'sx-win-tabhidden' : '',
    w.modal ? 'sx-win-modal' : '',
    w.minimized && !asTab ? 'sx-win-hidden' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const style: React.CSSProperties = maximized
    ? { zIndex: zIndexOf(w), ...(minStrip && !asTab ? { height: `calc(100% - ${minStrip}px)` } : null) }
    : { left: w.x, top: w.y, width: w.w, height: w.h, zIndex: zIndexOf(w) };
  const Icon = kindIcon(w.kind);

  return (
    <div
      ref={rootRef}
      className={cls}
      style={style}
      data-window-id={id}
      data-window-kind={w.kind}
      role={w.modal ? 'dialog' : 'region'}
      aria-modal={w.modal || undefined}
      aria-label={w.title}
      aria-hidden={asTab && !currentTab ? true : undefined}
      tabIndex={-1}
      onPointerDownCapture={(e) => {
        if (active) return;
        // a click on a control puts the focus there itself; elsewhere (title bar, empty space)
        // the focus goes back to the control focused last
        const root = rootRef.current;
        const hit = (e.target as Element).closest?.(CLICK_FOCUSES);
        focusWindow(id, { content: !(root && inContent(hit, root)) });
      }}
      onFocusCapture={(e) => {
        // (the element itself, not rootRef: a field of a form that is already loaded focuses
        // itself (autoFocus) in the commit that mounts the window, before the ref is attached)
        const root = e.currentTarget;
        const t = e.target as HTMLElement;
        // (controls of the content only: not the title bar buttons)
        if (inContent(t, root)) {
          lastFocus.current = t;
          const holder = t.parentElement?.closest<HTMLElement>('[tabindex], [role="grid"]');
          lastHolder.current = holder && holder !== root && root.contains(holder) ? holder : null;
        }
        if (!useWindowStore.getState().windows.find((v) => v.id === id)?.minimized && useWindowStore.getState().activeId !== id) focusWindow(id, { content: false });
      }}
    >
      {!maximized && (
        <div
          className="sx-win-title"
          onPointerDown={startDrag}
          // a click on the title bar or its buttons keeps the keyboard focus on the control that has it
          onMouseDown={(e) => e.preventDefault()}
          onDoubleClick={() => !w.modal && w.resizable && !oneMode && toggleMaximize(id)}
        >
          <span className="sx-win-title-text">
            {!w.modal && <Icon size={14} strokeWidth={2} />}
            <span>{w.title}</span>
            {w.dirty && <span className="sx-win-dirty" title="Unsaved changes" />}
          </span>
          <div className="sx-win-btns">
            {!w.modal && !oneMode && (
              <button type="button" className="sx-wbtn" title="Minimize" tabIndex={-1} onClick={() => minimizeWindow(id)}>
                <GlyphMin />
              </button>
            )}
            {!w.modal && w.resizable && !oneMode && (
              <button type="button" className="sx-wbtn" title={w.maximized ? 'Restore Down' : 'Maximize'} tabIndex={-1} onClick={() => toggleMaximize(id)}>
                {w.maximized ? <GlyphRestore /> : <GlyphMax />}
              </button>
            )}
            <button type="button" className="sx-wbtn sx-wbtn-close" title="Close" tabIndex={-1} onClick={() => void closeWindow(id)}>
              <GlyphClose />
            </button>
          </div>
        </div>
      )}
      <div className="sx-win-body">
        <WindowContent kind={w.kind} props={w.props} api={api} />
      </div>
      {!maximized && w.resizable && DIRS.map((d) => <div key={d} className={`sx-rz sx-rz-${d}`} onPointerDown={startResize(d)} />)}
    </div>
  );
});

/** Window content: memoized so dragging/resizing does not re-render the module. */
const WindowContent = memo(function WindowContent({ kind, props, api }: { kind: WindowKind; props: Record<string, any>; api: WindowApi }) {
  const Comp = windowComponent(kind);
  // React never passes `key` (or `ref`) to a component: the report window's `key`
  // prop is also given as `reportKey` (and is always in useWindow().props.key).
  const { key, ref, ...rest } = props;
  const compProps = key !== undefined ? { ...rest, reportKey: key } : rest;
  return (
    <WindowContext.Provider value={api}>
      <WindowErrorBoundary title={api.kind} onClose={() => void api.close(true)}>
        <Suspense fallback={<div className="sx-win-loading">Loading...</div>}>
          <Comp {...compProps} />
        </Suspense>
      </WindowErrorBoundary>
    </WindowContext.Provider>
  );
});

interface EBProps {
  title: string;
  onClose(): void;
  children: ReactNode;
}

/** Shows a window's render error inside the window instead of breaking the app. */
class WindowErrorBoundary extends Component<EBProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Window "${this.props.title}" failed:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="sx-win-error">
        <div className="sx-win-error-box">
          <div className="sx-win-error-icon">!</div>
          <div className="sx-win-error-text">
            <div className="sx-win-error-title">This window could not be displayed.</div>
            <div className="sx-win-error-msg">{error.message || String(error)}</div>
            {error.stack && <pre className="sx-win-error-stack">{error.stack}</pre>}
            <div className="sx-win-error-buttons">
              <button type="button" className="sx-shell-btn" onClick={() => this.setState({ error: null })}>
                Try Again
              </button>
              <button type="button" className="sx-shell-btn" onClick={this.props.onClose}>
                Close Window
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
