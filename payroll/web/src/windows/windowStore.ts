// Window manager store (Tabs workspace and classic floating MDI windows).
// Modules call openWindow / closeWindow / openRecord; everything else is
// used by the shell.
// The order of `windows` is the tab order (Tabs workspace); the floating
// desktop stacks windows by `z`.
import { create } from 'zustand';
import { useView, isTabsMode } from '@/state/view';
import { dialogsComeBack, dialogsStepAside } from '@/components/layers';
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
}

function fallbackDesktop() {
  if (typeof window === 'undefined') return { w: 1200, h: 760 };
  return { w: Math.max(400, window.innerWidth - 220), h: Math.max(300, window.innerHeight - 110) };
}

export const useWindowStore = create<WindowStoreState>(() => ({ windows: [], activeId: null, desktop: fallbackDesktop() }));

let seq = 0;
let zSeq = 0;
let minSeq = 0;
const TITLE_H = 26;

const hooks = new Map<string, () => Promise<boolean>>();
const closing = new Map<string, Promise<boolean>>();

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

// Windows opened while message boxes / showDialog() boxes are on screen: the boxes step aside
// (they would cover the window) until the window closes.
const asideFor = new Set<string>();
function stepAsideFor(id: string) {
  if (!asideFor.has(id) && dialogsStepAside(id)) asideFor.add(id);
}
useWindowStore.subscribe((st) => {
  if (!asideFor.size) return;
  for (const id of [...asideFor]) {
    if (st.windows.some((w) => w.id === id)) continue;
    asideFor.delete(id);
    dialogsComeBack(id);
  }
});

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
    stepAsideFor(existing.id);
    focusWindow(existing.id);
    return existing.id;
  }

  const id = `w${++seq}`;
  const desk = s.desktop;
  const modal = !!def.modal;
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
    x = Math.max(0, Math.min(8 + off, desk.w - w));
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
  stepAsideFor(id);
  return id;
}

/** Bring a window to the front and make it active (restores it when minimized). */
export function focusWindow(id: string): void {
  const s = get();
  const w = s.windows.find((v) => v.id === id);
  if (!w) return;
  const topModal = getTopModal();
  if (topModal && !w.modal && topModal.id !== id) {
    // Blocked by a modal dialog: only raise it behind the dialog.
    patch(id, { z: ++zSeq, minimized: false });
    flashWindow(topModal.id);
    return;
  }
  if (topModal && w.modal && w.id !== topModal.id) {
    // A lower modal dialog cannot be activated while a newer one is open.
    flashWindow(topModal.id);
    return;
  }
  const top = s.windows.reduce((m, v) => Math.max(m, v.z), 0);
  if (s.activeId === id && w.z === top && !w.minimized) return;
  set((st) => ({
    windows: st.windows.map((v) => (v.id === id ? { ...v, z: ++zSeq, minimized: false } : v)),
    activeId: id,
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
  const pending = closing.get(id);
  if (pending) return pending;
  const p = (async () => {
    const w = get().windows.find((v) => v.id === id);
    if (!w) return true;
    const hook = hooks.get(id);
    if (!opts.force && hook) {
      if (w.minimized || get().activeId !== id) focusWindow(id);
      let ok = false;
      try {
        ok = await hook();
      } catch (e) {
        console.error(e);
        ok = false;
      }
      if (!ok) return false;
    }
    hooks.delete(id);
    set((s) => {
      const windows = s.windows.filter((v) => v.id !== id);
      return { windows, activeId: s.activeId === id || !windows.some((v) => v.id === s.activeId) ? pickActive(windows) : s.activeId };
    });
    return true;
  })();
  closing.set(id, p);
  p.finally(() => closing.delete(id));
  return p;
}

/** Close every window (top first), asking each one to save. False when one cancelled. */
export async function closeAllWindows(): Promise<boolean> {
  const order = [...get().windows].sort((a, b) => (b.modal ? 1e12 : 0) + b.z - ((a.modal ? 1e12 : 0) + a.z));
  for (const w of order) {
    if (!(await closeWindow(w.id))) return false;
  }
  return true;
}

/** Close every document window except this one (tab menu). False when one cancelled. */
export async function closeOtherWindows(keepId: string): Promise<boolean> {
  const others = get().windows.filter((w) => !w.modal && w.id !== keepId);
  for (const w of others) {
    if (!(await closeWindow(w.id))) return false;
  }
  focusWindow(keepId);
  return true;
}

/** Close the document windows after this one in tab order (tab menu). */
export async function closeWindowsAfter(id: string): Promise<boolean> {
  const docs = get().windows.filter((w) => !w.modal);
  const i = docs.findIndex((w) => w.id === id);
  if (i < 0) return true;
  for (const w of docs.slice(i + 1)) {
    if (!(await closeWindow(w.id))) return false;
  }
  return true;
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
    const windows = s.windows.map((v) => (v.id === id ? { ...v, minimized: true, minOrder: ++minSeq } : v));
    return { windows, activeId: s.activeId === id ? pickActive(windows) : s.activeId };
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
    patch(id, { minimized: false });
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
  const { desktop } = get();
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

/** Window > Tile Vertically (side by side) / Tile Horizontally (stacked). */
export function tileWindows(mode: 'vertical' | 'horizontal'): void {
  if (isOneWindowMode()) return;
  const list = tileable();
  const n = list.length;
  if (!n) return;
  const { desktop } = get();
  // Leave room for the minimized title tabs.
  const hasMin = get().windows.some((w) => w.minimized);
  const H = desktop.h - (hasMin ? TITLE_H + 2 : 0);
  const W = desktop.w;
  let cols: number;
  let rows: number;
  if (mode === 'vertical') {
    cols = n <= 3 ? n : Math.ceil(Math.sqrt(n));
    rows = Math.ceil(n / cols);
  } else {
    rows = n <= 3 ? n : Math.ceil(Math.sqrt(n));
    cols = Math.ceil(n / rows);
  }
  const map = new Map<string, Partial<WinState>>();
  list.forEach((w, i) => {
    let c: number;
    let r: number;
    let colsInRow = cols;
    let rowsInCol = rows;
    if (mode === 'vertical') {
      // fill columns top to bottom; the last column may have fewer rows
      c = Math.floor(i / rows);
      r = i % rows;
      const lastCol = Math.floor((n - 1) / rows);
      if (c === lastCol) rowsInCol = n - lastCol * rows;
      const cw = W / cols;
      const rh = H / rowsInCol;
      map.set(w.id, { x: c * cw, y: r * rh, w: cw, h: rh, maximized: false });
    } else {
      r = Math.floor(i / cols);
      c = i % cols;
      const lastRow = Math.floor((n - 1) / cols);
      if (r === lastRow) colsInRow = n - lastRow * cols;
      const rh = H / rows;
      const cw = W / colsInRow;
      map.set(w.id, { x: c * cw, y: r * rh, w: cw, h: rh, maximized: false });
    }
  });
  set((s) => ({
    windows: s.windows.map((w) => {
      const p = map.get(w.id);
      if (!p) return w.modal ? w : { ...w, maximized: false };
      return { ...w, ...p, x: Math.round(p.x!), y: Math.round(p.y!), w: Math.max(120, Math.floor(p.w!)), h: Math.max(TITLE_H + 20, Math.floor(p.h!)) };
    }),
  }));
}

/** Window > Arrange Icons: re-pack the minimized title tabs in their current order. */
export function arrangeIcons(): void {
  const mins = get()
    .windows.filter((w) => w.minimized)
    .sort((a, b) => a.minOrder - b.minOrder);
  const order = new Map(mins.map((w, i) => [w.id, i + 1]));
  minSeq = mins.length;
  set((s) => ({ windows: s.windows.map((w) => (order.has(w.id) ? { ...w, minOrder: order.get(w.id)! } : w)) }));
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

/** Update the singleton key of a window from (partial) props describing what it shows now. */
export function setWindowKeyProps(id: string, keyProps: Record<string, any>): void {
  const w = get().windows.find((v) => v.id === id);
  if (!w) return;
  const key = windowKey(w.kind, { ...w.props, ...keyProps });
  if (key !== w.key) patch(id, { key });
}

/** Called by the Desktop when its size changes: keep windows reachable. */
export function setDesktopSize(w: number, h: number): void {
  const s = get();
  if (s.desktop.w === w && s.desktop.h === h) return;
  set({
    desktop: { w, h },
    windows: s.windows.map((v) => {
      const x = Math.min(v.x, Math.max(0, w - 60));
      const y = Math.min(v.y, Math.max(0, h - TITLE_H));
      return x === v.x && y === v.y ? v : { ...v, x, y };
    }),
  });
}

/** Send a keyboard shortcut to the active window (menu items that act on the window content use it). */
export function sendKeyToActiveWindow(init: { key: string; code: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): void {
  const w = getActiveWindow();
  if (!w) return;
  const root = document.querySelector(`[data-window-id="${w.id}"]`);
  if (!root) return;
  const ae = document.activeElement;
  const target = ae && root.contains(ae) ? ae : root.querySelector('.sx-win-body') ?? root;
  target.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }));
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
      return { windows, activeId: pickActive(windows) };
    });
  }
});

export type RecordKind = 'paycheck' | 'liability_payment' | 'adjustment' | 'employee' | 'item';

/** Open the window that shows/edits a payroll record (report drill-down, lists, sync window). */
export function openRecord(kind: RecordKind, id: number): void {
  switch (kind) {
    case 'paycheck':
      openWindow('paycheck', { id });
      break;
    case 'liability_payment':
      openWindow('liabilityPayment', { id });
      break;
    case 'adjustment':
      openWindow('adjustLiabilities', { id });
      break;
    case 'employee':
      openWindow('employeeEdit', { id });
      break;
    case 'item':
      openWindow('payrollItemEdit', { id });
      break;
  }
}
