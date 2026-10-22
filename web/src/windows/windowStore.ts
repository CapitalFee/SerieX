// Window manager store (Tabs workspace and classic floating MDI windows).
// Modules call openWindow / closeWindow / openTxn; everything else is used by the shell.
// The order of `windows` is the tab order (Tabs workspace); the floating
// desktop stacks windows by `z`.
import { create } from 'zustand';
import type { TxnType } from '@/api/types';
import { useView, isTabsMode } from '@/state/view';
import type { WindowKind } from './kinds';
import { REGISTRY, defaultTitle, windowKey } from './registry';

export interface WinState {
  id: string;
  kind: WindowKind;
  key: string; // singleton key
  props: Record<string, any>;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  dirty: boolean;
  modal: boolean;
  /** Title set by the content with setTitle() (registry title no longer applies). */
  customTitle: boolean;
  resizable: boolean;
  minW: number;
  minH: number;
  /** Order in which the window was minimized (position of its title tab). */
  minOrder: number;
}

export interface WindowStoreState {
  windows: WinState[];
  activeId: string | null;
  /** Size of the desktop (MDI client area) in px, kept by the Desktop component. */
  desktop: { w: number; h: number };
  /**
   * Latest request to put the keyboard focus inside a window (on the control focused there last,
   * else its first field): set each time a window is focused or brought to the front, and when a
   * window becomes active because the one above it closed or was minimized. `n` counts requests.
   */
  focusReq: { id: string | null; n: number };
}

function fallbackDesktop() {
  if (typeof window === 'undefined') return { w: 1200, h: 760 };
  return { w: Math.max(400, window.innerWidth - 220), h: Math.max(300, window.innerHeight - 110) };
}

export const useWindowStore = create<WindowStoreState>(() => ({ windows: [], activeId: null, desktop: fallbackDesktop(), focusReq: { id: null, n: 0 } }));

let seq = 0;
let zSeq = 0;
let minSeq = 0;
const TITLE_H = 26;

const hooks = new Map<string, () => Promise<boolean>>();
const closing = new Map<string, Promise<boolean>>();
/** Windows whose "save changes?" hook is running (its Yes may save and close the window itself). */
const inHook = new Set<string>();

const get = () => useWindowStore.getState();
const set = useWindowStore.setState;

function patch(id: string, p: Partial<WinState>) {
  set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, ...p } : w)) }));
}

/** Top-most open modal window, if any. */
export function getTopModal(): WinState | null {
  let top: WinState | null = null;
  for (const w of get().windows) if (w.modal && (!top || w.z > top.z)) top = w;
  return top;
}

/** Window that receives the keyboard (top modal first, else the active window). */
export function getActiveWindow(): WinState | null {
  const s = get();
  return s.windows.find((w) => w.id === s.activeId) ?? null;
}

/** Pick the window that should become active (top modal, else top visible window). */
function pickActive(windows: WinState[]): string | null {
  let best: WinState | null = null;
  for (const w of windows) {
    if (w.minimized) continue;
    const rank = (x: WinState) => (x.modal ? 1e12 : 0) + x.z;
    if (!best || rank(w) > rank(best)) best = w;
  }
  return best?.id ?? null;
}

/** Tabs workspace: every document window is a full-size page shown as a tab. */
function isOneWindowMode() {
  return isTabsMode();
}

/** Size of a minimized window's title bar at the bottom of the desktop (floating windows). */
export const MIN_TAB_W = 180;
export const MIN_TAB_H = 30;

/**
 * Height of the row(s) of minimized title bars at the bottom of the floating desktop (0 when
 * none, or in the Tabs workspace). The bars stay above the windows; windows are kept above them.
 */
export function minimizedStripHeight(state: WindowStoreState = get(), tabs: boolean = isOneWindowMode()): number {
  if (tabs) return 0;
  const n = state.windows.filter((w) => w.minimized).length;
  if (!n) return 0;
  const perRow = Math.max(1, Math.floor((state.desktop.w - 4) / (MIN_TAB_W + 2)));
  return Math.ceil(n / perRow) * (MIN_TAB_H + 2) + 2;
}

/**
 * Windows reaching into the minimized title bars are made shorter (never below their minimum
 * size), or moved up, so they end above the bars and nothing of them is hidden.
 */
function fitAboveMinimized(windows: WinState[], desktop: { w: number; h: number }): WinState[] {
  const strip = minimizedStripHeight({ ...get(), windows, desktop });
  if (!strip) return windows;
  const H = desktop.h - strip;
  if (H < 80) return windows;
  return windows.map((v) => {
    if (v.modal || v.minimized || v.y + v.h <= H) return v;
    let y = v.y;
    let h = Math.min(v.h, H - y);
    const minH = Math.min(v.minH, v.h, H);
    if (h < minH) {
      h = minH;
      y = Math.max(0, H - h);
    }
    return y === v.y && h === v.h ? v : { ...v, y, h };
  });
}

/**
 * The windows with `id` shown again (no longer minimized) and on top. A window restored from its
 * minimized title bar ends above the bars still at the bottom of the desktop (floating windows),
 * like a window that is minimized, arranged or opened.
 */
function raised(windows: WinState[], id: string, desktop: { w: number; h: number }): WinState[] {
  const wasMinimized = !!windows.find((v) => v.id === id)?.minimized;
  const next = windows.map((v) => (v.id === id ? { ...v, z: ++zSeq, minimized: false } : v));
  return wasMinimized && !isOneWindowMode() ? fitAboveMinimized(next, desktop) : next;
}

/** State change asking window `id` to take the keyboard focus (see WindowStoreState.focusReq). */
function focusRequest(st: WindowStoreState, id: string | null): Pick<WindowStoreState, 'focusReq'> | null {
  return id ? { focusReq: { id, n: st.focusReq.n + 1 } } : null;
}

/** State change for a new active window: it takes the keyboard focus when it was not active before. */
function activate(st: WindowStoreState, activeId: string | null): Partial<WindowStoreState> {
  return { activeId, ...(activeId && activeId !== st.activeId ? focusRequest(st, activeId) : null) };
}

/** Id of the document window shown in the Tabs workspace (top non-modal window). */
export function getCurrentTabId(state: WindowStoreState = get()): string | null {
  let top: WinState | null = null;
  for (const w of state.windows) if (!w.modal && !w.minimized && (!top || w.z > top.z)) top = w;
  return top?.id ?? null;
}

function shallowSame(a: Record<string, any>, b: Record<string, any>) {
  for (const k of Object.keys(b)) if (a[k] !== b[k]) return false;
  return true;
}

/** Open (or focus an existing) window. Returns the window id. */
export function openWindow(kind: WindowKind, props: Record<string, any> = {}, opts: { title?: string } = {}): string {
  const def = REGISTRY[kind];
  const key = windowKey(kind, props);
  const s = get();
  const existing = s.windows.find((w) => w.key === key);
  if (existing) {
    const p: Partial<WinState> = {};
    if (!shallowSame(existing.props, props)) p.props = { ...existing.props, ...props };
    if (opts.title) {
      p.title = opts.title;
      p.customTitle = true;
    } else if (p.props && !existing.customTitle) p.title = defaultTitle(kind, p.props);
    if (Object.keys(p).length) patch(existing.id, p);
    focusWindow(existing.id);
    return existing.id;
  }

  const id = `w${++seq}`;
  const modal = !!def.modal;
  // document windows open above the minimized title bars (floating windows)
  const strip = modal ? 0 : minimizedStripHeight(s);
  // a desktop not laid out yet (the page is still opening, e.g. hidden) does not size the window:
  // it opens at its usual size and is fitted once the desktop has its real size (setDesktopSize)
  const laidOut = s.desktop.w >= 120 && s.desktop.h >= 80;
  const space = laidOut ? s.desktop : { w: def.width + 4, h: def.height + 4 };
  const desk = strip && space.h - strip >= 200 ? { w: space.w, h: space.h - strip } : space;
  const minW = def.minWidth ?? 260;
  const minH = def.minHeight ?? 150;
  const w = Math.max(Math.min(def.width, desk.w - 4), Math.min(minW, desk.w));
  const h = Math.max(Math.min(def.height, desk.h - 4), Math.min(minH, desk.h));
  let x: number;
  let y: number;
  if (modal) {
    const modals = s.windows.filter((v) => v.modal).length;
    x = Math.max(0, Math.round((desk.w - w) / 2) + modals * 20);
    y = Math.max(0, Math.round((desk.h - h) / 2.6) + modals * 20);
  } else {
    const visible = s.windows.filter((v) => !v.modal && !v.minimized).length;
    const off = (visible % 10) * 24;
    // cascaded, but not against the right edge of the desktop when there is room for a margin
    const right = desk.w - w - 8 >= 0 ? desk.w - w - 8 : desk.w - w;
    x = Math.max(0, Math.min(8 + off, right));
    y = Math.max(0, Math.min(6 + off, desk.h - h));
  }
  // Tabs workspace: the floating geometry is kept for a later switch to Floating windows.
  const maximized = !modal && !isOneWindowMode() && s.windows.some((v) => !v.modal && v.maximized && !v.minimized);
  const win: WinState = {
    id,
    kind,
    key,
    props,
    title: opts.title ?? defaultTitle(kind, props),
    customTitle: !!opts.title,
    x,
    y,
    w,
    h,
    z: ++zSeq,
    minimized: false,
    maximized,
    dirty: false,
    modal,
    resizable: def.resizable ?? true,
    minW,
    minH,
    minOrder: 0,
  };
  set((st) => {
    const windows = [...st.windows, win];
    // A non-modal window opened from inside a modal dialog stays behind the dialog.
    const topModal = windows.filter((v) => v.modal && v.id !== id).sort((a, b) => b.z - a.z)[0];
    return { windows, activeId: !modal && topModal ? topModal.id : id };
  });
  return id;
}

/**
 * Bring a window to the front and make it active (restores it when minimized). The keyboard
 * focus goes into it (on the control focused there last, else its first field), also when it
 * already is the active window; `{ content: false }` leaves the focus alone (a click on one of
 * its controls, which takes the focus itself, or arrow keys moving along the tabs).
 */
export function focusWindow(id: string, opts: { content?: boolean } = {}): void {
  const s = get();
  const w = s.windows.find((v) => v.id === id);
  if (!w) return;
  const topModal = getTopModal();
  if (topModal && !w.modal && topModal.id !== id) {
    // Blocked by a modal dialog: only raise it behind the dialog.
    set((st) => ({ windows: raised(st.windows, id, st.desktop) }));
    flashWindow(topModal.id);
    return;
  }
  if (topModal && w.modal && w.id !== topModal.id) {
    // A lower modal dialog cannot be activated while a newer one is open.
    flashWindow(topModal.id);
    return;
  }
  const content = opts.content !== false;
  const top = s.windows.reduce((m, v) => Math.max(m, v.z), 0);
  if (s.activeId === id && w.z === top && !w.minimized) {
    if (content) set((st) => ({ ...focusRequest(st, id) }));
    return;
  }
  set((st) => ({
    windows: raised(st.windows, id, st.desktop),
    activeId: id,
    ...(content ? focusRequest(st, id) : null),
  }));
}

/** Briefly flash a window's title (click outside a modal dialog). */
export function flashWindow(id: string): void {
  if (typeof document === 'undefined') return;
  const el = document.querySelector(`[data-window-id="${id}"]`);
  if (!el) return;
  el.classList.remove('sx-flash');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('sx-flash');
  setTimeout(() => el.classList.remove('sx-flash'), 600);
}

/** Close a window; resolves false when its beforeClose hook cancelled. */
export function closeWindow(id: string, opts: { force?: boolean } = {}): Promise<boolean> {
  // A window asked to close from its own beforeClose hook (Yes = save, then the content closes
  // itself): the close already under way finishes it.
  if (inHook.has(id)) return Promise.resolve(true);
  const pending = closing.get(id);
  if (pending) return pending;
  const p = (async () => {
    const w = get().windows.find((v) => v.id === id);
    if (!w) return true;
    const hook = hooks.get(id);
    if (!opts.force && hook) {
      if (w.minimized || get().activeId !== id) focusWindow(id);
      const ok = await runHook(id, hook);
      if (!ok) {
        focusAfterCancel(id);
        return false;
      }
    }
    hooks.delete(id);
    set((s) => {
      const windows = s.windows.filter((v) => v.id !== id);
      return { windows, ...activate(s, s.activeId === id || !windows.some((v) => v.id === s.activeId) ? pickActive(windows) : s.activeId) };
    });
    return true;
  })();
  closing.set(id, p);
  p.finally(() => closing.delete(id));
  return p;
}

/** Cancel in a window's "save changes?" box: the keyboard goes back into the window when it is the active one. */
function focusAfterCancel(id: string): void {
  if (get().activeId === id) set((st) => ({ ...focusRequest(st, id) }));
}

async function runHook(id: string, hook: () => Promise<boolean>): Promise<boolean> {
  inHook.add(id);
  try {
    return await hook();
  } catch (e) {
    console.error(e);
    return false;
  } finally {
    inHook.delete(id);
  }
}

/**
 * Closes several windows as one action: first every window with changes is asked to save (the
 * changed ones first, each brought to the front), and the first Cancel stops everything before
 * any window is closed; then they all close. False when one cancelled.
 */
async function closeMany(ids: string[]): Promise<boolean> {
  const list = ids.map((id) => get().windows.find((w) => w.id === id)).filter((w): w is WinState => !!w);
  const ordered = [...list.filter((w) => w.dirty), ...list.filter((w) => !w.dirty)];
  for (const w of ordered) {
    const hook = hooks.get(w.id);
    if (!hook || !get().windows.some((v) => v.id === w.id)) continue;
    if (w.dirty && (w.minimized || get().activeId !== w.id)) focusWindow(w.id);
    if (!(await runHook(w.id, hook))) {
      focusAfterCancel(w.id);
      return false;
    }
  }
  for (const w of list) await closeWindow(w.id, { force: true });
  return true;
}

/** Close every window (top first), asking each one to save. False when one cancelled (then none is closed). */
export async function closeAllWindows(): Promise<boolean> {
  const order = [...get().windows].sort((a, b) => (b.modal ? 1e12 : 0) + b.z - ((a.modal ? 1e12 : 0) + a.z));
  return closeMany(order.map((w) => w.id));
}

/** Close every document window except this one (tab menu). False when one cancelled. */
export async function closeOtherWindows(keepId: string): Promise<boolean> {
  const others = get().windows.filter((w) => !w.modal && w.id !== keepId);
  if (!(await closeMany(others.map((w) => w.id)))) return false;
  focusWindow(keepId);
  return true;
}

/** Close the document windows after this one in tab order (tab menu). */
export async function closeWindowsAfter(id: string): Promise<boolean> {
  const docs = get().windows.filter((w) => !w.modal);
  const i = docs.findIndex((w) => w.id === id);
  if (i < 0) return true;
  return closeMany(docs.slice(i + 1).map((w) => w.id));
}

/** Move a tab to a new position among the document windows (drag to reorder). */
export function moveTab(id: string, toIndex: number): void {
  const s = get();
  const docs = s.windows.filter((w) => !w.modal);
  const from = docs.findIndex((w) => w.id === id);
  if (from < 0) return;
  const to = Math.max(0, Math.min(docs.length - 1, toIndex));
  if (from === to) return;
  const order = [...docs];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  set({ windows: [...order, ...s.windows.filter((w) => w.modal)] });
}

/** Close every window without asking (company closed). */
export function forceCloseAllWindows(): void {
  hooks.clear();
  set({ windows: [], activeId: null });
}

export function minimizeWindow(id: string): void {
  const w = get().windows.find((v) => v.id === id);
  if (!w || w.modal || isOneWindowMode()) return;
  set((s) => {
    // its title bar joins the row at the bottom: windows reaching into it end above it
    const windows = fitAboveMinimized(
      s.windows.map((v) => (v.id === id ? { ...v, minimized: true, minOrder: ++minSeq } : v)),
      s.desktop,
    );
    return { windows, ...activate(s, s.activeId === id ? pickActive(windows) : s.activeId) };
  });
}

/** Maximize (MDI style: every document window shows maximized until restored). */
export function maximizeWindow(id: string): void {
  const w = get().windows.find((v) => v.id === id);
  if (!w || w.modal || !w.resizable) return;
  set((s) => ({ windows: s.windows.map((v) => (v.modal || !v.resizable ? v : { ...v, maximized: true, ...(v.id === id ? { minimized: false } : {}) })) }));
  focusWindow(id);
}

/** Restore a minimized window, or un-maximize the windows. */
export function restoreWindow(id: string): void {
  const w = get().windows.find((v) => v.id === id);
  if (!w) return;
  if (w.minimized) {
    // back above the title bars still minimized (it may reach under them: it was never fitted
    // while minimized, and bars minimized after it sit where its bottom edge is)
    set((s) => ({ windows: raised(s.windows, id, s.desktop) }));
  } else if (w.maximized && !isOneWindowMode()) {
    set((s) => ({ windows: s.windows.map((v) => (v.maximized ? { ...v, maximized: false } : v)) }));
  }
  focusWindow(id);
}

export function toggleMaximize(id: string): void {
  const w = get().windows.find((v) => v.id === id);
  if (!w) return;
  if (w.maximized) restoreWindow(id);
  else maximizeWindow(id);
}

/** Move a window, keeping its title bar reachable. */
export function moveWindow(id: string, x: number, y: number): void {
  const { desktop } = get();
  const w = get().windows.find((v) => v.id === id);
  if (!w) return;
  const nx = Math.round(Math.min(Math.max(x, -w.w + 80), desktop.w - 60));
  const ny = Math.round(Math.min(Math.max(y, 0), desktop.h - TITLE_H));
  if (nx !== w.x || ny !== w.y) patch(id, { x: nx, y: ny });
}

/** Set a window's position and size (min size enforced). */
export function resizeWindow(id: string, r: { x: number; y: number; w: number; h: number }): void {
  const w = get().windows.find((v) => v.id === id);
  if (!w) return;
  patch(id, { x: Math.round(r.x), y: Math.round(Math.max(0, r.y)), w: Math.round(Math.max(w.minW, r.w)), h: Math.round(Math.max(w.minH, r.h)) });
}

function tileable(): WinState[] {
  return get()
    .windows.filter((w) => !w.modal && !w.minimized)
    .sort((a, b) => a.z - b.z);
}

/** Window > Cascade. */
export function cascadeWindows(): void {
  if (isOneWindowMode()) return;
  const list = tileable();
  // leave room for the minimized title bars
  const strip = minimizedStripHeight();
  const desktop = { w: get().desktop.w, h: get().desktop.h - strip };
  const step = 26;
  const n = list.length;
  const map = new Map<string, Partial<WinState>>();
  list.forEach((w, i) => {
    const off = (i % 12) * step;
    const def = REGISTRY[w.kind];
    const ww = Math.max(w.minW, Math.min(def.width, desktop.w - (n - 1) * step - 4, desktop.w - off));
    const hh = Math.max(w.minH, Math.min(def.height, desktop.h - (n - 1) * step - 4, desktop.h - off));
    map.set(w.id, { x: off, y: off, w: ww, h: hh, maximized: false });
  });
  set((s) => ({ windows: s.windows.map((w) => (map.has(w.id) ? { ...w, ...map.get(w.id)! } : w.modal ? w : { ...w, maximized: false })) }));
}

/**
 * Window > Tile Vertically (side by side) / Tile Horizontally (stacked). Windows never get
 * smaller than their minimum size (forms and centers need room for their layout): the grid uses
 * as many columns / rows as fit; when the windows do not all fit, they are cascaded instead and
 * false is returned (the caller may say so).
 */
export function tileWindows(mode: 'vertical' | 'horizontal'): boolean {
  if (isOneWindowMode()) return true;
  const list = tileable();
  const n = list.length;
  if (!n) return true;
  const { desktop } = get();
  // Leave room for the minimized title tabs.
  const H = desktop.h - minimizedStripHeight();
  const W = desktop.w;
  const needW = Math.min(W, Math.max(...list.map((w) => w.minW)));
  const needH = Math.min(H, Math.max(...list.map((w) => w.minH)));
  const maxCols = Math.max(1, Math.floor(W / needW));
  const maxRows = Math.max(1, Math.floor(H / needH));
  let cols: number;
  let rows: number;
  if (mode === 'vertical') {
    cols = Math.min(n <= 3 ? n : Math.ceil(Math.sqrt(n)), maxCols);
    rows = Math.ceil(n / cols);
  } else {
    rows = Math.min(n <= 3 ? n : Math.ceil(Math.sqrt(n)), maxRows);
    cols = Math.ceil(n / rows);
  }
  if (n > 1 && (rows > maxRows || cols > maxCols)) {
    // not enough room to put them side by side at a usable size
    cascadeWindows();
    return false;
  }
  const map = new Map<string, Partial<WinState>>();
  list.forEach((w, i) => {
    let c: number;
    let r: number;
    if (mode === 'vertical') {
      // fill columns top to bottom; the last column may have fewer rows
      c = Math.floor(i / rows);
      r = i % rows;
      const lastCol = Math.floor((n - 1) / rows);
      const rowsInCol = c === lastCol ? n - lastCol * rows : rows;
      const cw = W / cols;
      const rh = H / rowsInCol;
      map.set(w.id, { x: c * cw, y: r * rh, w: cw, h: rh, maximized: false });
    } else {
      r = Math.floor(i / cols);
      c = i % cols;
      const lastRow = Math.floor((n - 1) / cols);
      const colsInRow = r === lastRow ? n - lastRow * cols : cols;
      const rh = H / rows;
      const cw = W / colsInRow;
      map.set(w.id, { x: c * cw, y: r * rh, w: cw, h: rh, maximized: false });
    }
  });
  set((s) => ({
    windows: s.windows.map((w) => {
      const p = map.get(w.id);
      if (!p) return w.modal ? w : { ...w, maximized: false };
      return { ...w, ...p, x: Math.round(p.x!), y: Math.round(p.y!), w: Math.max(Math.min(w.minW, W), Math.floor(p.w!)), h: Math.max(Math.min(w.minH, H), Math.floor(p.h!)) };
    }),
  }));
  return true;
}

/**
 * Window > Arrange Icons: re-pack the minimized title tabs in their current order along the
 * bottom of the desktop, and make room for them (windows reaching into them end above them).
 */
export function arrangeIcons(): void {
  const mins = get()
    .windows.filter((w) => w.minimized)
    .sort((a, b) => a.minOrder - b.minOrder);
  const order = new Map(mins.map((w, i) => [w.id, i + 1]));
  minSeq = mins.length;
  set((s) => ({ windows: fitAboveMinimized(s.windows.map((w) => (order.has(w.id) ? { ...w, minOrder: order.get(w.id)! } : w)), s.desktop) }));
}

/** Ctrl+Tab / Ctrl+F6: activate the next (or previous) window. */
export function nextWindow(dir: 1 | -1 = 1): void {
  if (getTopModal()) return;
  const list = get().windows.filter((w) => !w.modal);
  if (list.length < 2) return;
  const active = get().activeId;
  const i = list.findIndex((w) => w.id === active);
  const next = list[(i + dir + list.length) % list.length];
  focusWindow(next.id);
}

export function setWindowTitle(id: string, title: string): void {
  const w = get().windows.find((v) => v.id === id);
  if (w && (w.title !== title || !w.customTitle)) patch(id, { title, customTitle: true });
}

export function setWindowDirty(id: string, dirty: boolean): void {
  const w = get().windows.find((v) => v.id === id);
  if (w && w.dirty !== dirty) patch(id, { dirty });
}

export function setBeforeClose(id: string, fn: (() => Promise<boolean>) | null): void {
  if (fn) hooks.set(id, fn);
  else hooks.delete(id);
}

/**
 * Change some props of a window (an `undefined` value removes the prop); its content re-renders
 * with them. The singleton key is left alone (setWindowKeyProps updates it).
 */
export function setWindowProps(id: string, changes: Record<string, any>): void {
  const w = get().windows.find((v) => v.id === id);
  if (!w) return;
  const props = { ...w.props };
  let changed = false;
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) {
      if (k in props) {
        delete props[k];
        changed = true;
      }
    } else if (props[k] !== v) {
      props[k] = v;
      changed = true;
    }
  }
  if (changed) patch(id, { props });
}

/** Update the singleton key of a window from (partial) props describing what it shows now. */
export function setWindowKeyProps(id: string, keyProps: Record<string, any>): void {
  const w = get().windows.find((v) => v.id === id);
  if (!w) return;
  const key = windowKey(w.kind, { ...w.props, ...keyProps });
  if (key !== w.key) patch(id, { key });
}

/**
 * Called by the Desktop when its size changes: every floating window is made to fit the desktop
 * again (smaller when needed, never below its minimum size, and moved so it is entirely
 * visible), so its title bar and Save buttons stay on screen. Windows do not grow back.
 */
export function setDesktopSize(w: number, h: number): void {
  const s = get();
  if (s.desktop.w === w && s.desktop.h === h) return;
  // a desktop not laid out yet (0 x 0) never shrinks the windows
  if (w < 120 || h < 80) {
    set({ desktop: { w, h } });
    return;
  }
  const fitted = s.windows.map((v) => {
    const ww = Math.max(Math.min(v.w, w), Math.min(v.minW, v.w));
    const hh = Math.max(Math.min(v.h, h), Math.min(v.minH, v.h));
    const x = Math.max(0, Math.min(v.x, w - ww));
    const y = Math.max(0, Math.min(v.y, h - hh));
    return x === v.x && y === v.y && ww === v.w && hh === v.h ? v : { ...v, x, y, w: ww, h: hh };
  });
  // and above the minimized title bars (floating windows)
  set({ desktop: { w, h }, windows: isOneWindowMode() ? fitted : fitAboveMinimized(fitted, { w, h }) });
}

/**
 * Send a keyboard shortcut to the active window (menu items like Transaction History use it).
 * Returns true when a shortcut of the window handled it.
 */
export function sendKeyToActiveWindow(init: { key: string; code: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): boolean {
  const w = getActiveWindow();
  if (!w) return false;
  const root = document.querySelector(`[data-window-id="${w.id}"]`);
  if (!root) return false;
  const ae = document.activeElement;
  const target = ae && root.contains(ae) ? ae : root.querySelector('.sx-win-body') ?? root;
  // window shortcuts run in the capture phase and stop a key they use: if it reaches the target, nobody did
  let reached = false;
  const probe = () => {
    reached = true;
  };
  target.addEventListener('keydown', probe);
  try {
    target.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }));
  } finally {
    target.removeEventListener('keydown', probe);
  }
  return !reached;
}

/** Ask the active window to run a menu command; it receives the window event "sx-menu-command". */
export function sendMenuCommand(command: string): void {
  const w = getActiveWindow();
  window.dispatchEvent(new CustomEvent('sx-menu-command', { detail: { command, windowId: w?.id ?? null, kind: w?.kind ?? null } }));
}

// Entering the Tabs workspace turns minimized windows back into tabs. The floating
// geometry (position, size, maximized) is kept for when Floating windows is chosen again.
useView.subscribe((s, prev) => {
  if (s.windowMode === prev.windowMode) return;
  if (s.windowMode === 'one') {
    set((st) => {
      const windows = st.windows.map((w) => (w.minimized ? { ...w, minimized: false } : w));
      // The active window must be the tab that shows (top modal, else top window).
      return { windows, ...activate(st, pickActive(windows)) };
    });
  }
});

const TXN_WINDOWS: Record<TxnType, [WindowKind, Record<string, any>]> = {
  INV: ['invoice', {}],
  SALESRCPT: ['salesReceipt', {}],
  PMT: ['receivePayment', {}],
  CREDMEM: ['creditMemo', {}],
  STMTCHG: ['statementCharges', {}],
  EST: ['estimate', {}],
  DEP: ['makeDeposit', {}],
  CHK: ['writeCheck', {}],
  REFUND: ['refund', {}],
  BILL: ['bill', {}],
  BILLCRED: ['bill', { credit: true }],
  BILLPMT: ['billPayment', {}],
  ITEMRCPT: ['receiveItems', {}],
  PURCHORD: ['purchaseOrder', {}],
  CCCHARGE: ['ccCharge', {}],
  CCCREDIT: ['ccCharge', { credit: true }],
  TRANSFER: ['transferFunds', {}],
  GENJRNL: ['journalEntry', {}],
  INVADJ: ['inventoryAdjust', {}],
  TAXPMT: ['salesTaxPayment', {}],
};

/** Open the form that edits a transaction. */
export function openTxn(type: TxnType, id: number): void {
  const entry = TXN_WINDOWS[type];
  if (!entry) return;
  const [kind, extra] = entry;
  const props: Record<string, any> = { ...extra, id };
  if (type === 'STMTCHG') props.txnId = id;
  openWindow(kind, props);
}
