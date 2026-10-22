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
  getCurrentTabId,
} from '@/windows/windowStore';
import { useView } from '@/state/view';
import { GlyphClose, GlyphMax, GlyphMin, GlyphRestore } from './glyphs';
import { kindIcon } from './kindIcons';

/** z-index layers inside the desktop: document windows < modal overlay < modal dialogs. */
export const MODAL_LAYER = 1_000_000;
export function zIndexOf(w: { z: number; modal: boolean }): number {
  return (w.modal ? MODAL_LAYER : 0) + w.z * 2;
}

const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Dir = (typeof DIRS)[number];

export const MdiWindow = memo(function MdiWindow({ id }: { id: string }) {
  const w = useWindowStore((s) => s.windows.find((v) => v.id === id));
  const active = useWindowStore((s) => s.activeId === id);
  const oneMode = useView((s) => s.windowMode === 'one');
  const currentTab = useWindowStore((s) => oneMode && getCurrentTabId(s) === id);
  const rootRef = useRef<HTMLDivElement>(null);

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
    ? { zIndex: zIndexOf(w) }
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
      onPointerDownCapture={() => {
        if (!active) focusWindow(id);
      }}
      onFocusCapture={() => {
        if (!useWindowStore.getState().windows.find((v) => v.id === id)?.minimized && useWindowStore.getState().activeId !== id) focusWindow(id);
      }}
    >
      {!maximized && (
        <div className="sx-win-title" onPointerDown={startDrag} onDoubleClick={() => !w.modal && w.resizable && !oneMode && toggleMaximize(id)}>
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
