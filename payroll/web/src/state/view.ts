// View choices of the View menu (workspace mode, navigation position), the
// selected bottom tab of the left navigation, collapsed navigation and
// collapsed navigation groups. Persisted per browser in localStorage "sxp.view"
// (same design as SerieX Books, own key so the two apps never share state).
import { create } from 'zustand';

export type IconBarMode = 'left' | 'top' | 'hidden';
/** 'one' = Tabs workspace (default), 'multiple' = Floating windows (classic MDI). */
export type WindowMode = 'multiple' | 'one';
/** 'shortcuts' = grouped navigation; 'liabilities' / 'windows' = the bottom tab panels. */
export type IconBarTab = 'shortcuts' | 'liabilities' | 'windows';

export interface ViewState {
  iconBar: IconBarMode;
  windowMode: WindowMode;
  iconBarTab: IconBarTab;
  /** Left navigation shows icons only. */
  navCollapsed: boolean;
  /** Navigation groups the user closed (group id -> true). */
  navClosed: Record<string, boolean>;
  setIconBar(m: IconBarMode): void;
  setWindowMode(m: WindowMode): void;
  setIconBarTab(t: IconBarTab): void;
  setNavCollapsed(c: boolean): void;
  setNavGroupOpen(id: string, open: boolean): void;
}

const KEY = 'sxp.view';
/** Version of the saved object. Version 1 defaulted to floating windows; its window mode is ignored. */
const VERSION = 2;

type Saved = Partial<Pick<ViewState, 'iconBar' | 'windowMode' | 'iconBarTab' | 'navCollapsed' | 'navClosed'>>;

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const out: Saved = {};
    if (['left', 'top', 'hidden'].includes(v.iconBar)) out.iconBar = v.iconBar;
    if (v.v >= VERSION && ['multiple', 'one'].includes(v.windowMode)) out.windowMode = v.windowMode;
    if (['shortcuts', 'liabilities', 'windows'].includes(v.iconBarTab)) out.iconBarTab = v.iconBarTab;
    if (typeof v.navCollapsed === 'boolean') out.navCollapsed = v.navCollapsed;
    if (v.navClosed && typeof v.navClosed === 'object') {
      const closed: Record<string, boolean> = {};
      for (const [k, x] of Object.entries(v.navClosed)) if (x === true) closed[k] = true;
      out.navClosed = closed;
    }
    return out;
  } catch {
    return {};
  }
}

function save(s: ViewState) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: VERSION,
        iconBar: s.iconBar,
        windowMode: s.windowMode,
        iconBarTab: s.iconBarTab,
        navCollapsed: s.navCollapsed,
        navClosed: s.navClosed,
      }),
    );
  } catch {
    /* storage unavailable */
  }
}

export const useView = create<ViewState>((set, get) => ({
  iconBar: 'left',
  windowMode: 'one',
  iconBarTab: 'shortcuts',
  navCollapsed: false,
  // Less used groups start closed so the navigation fits a 720 px high screen.
  navClosed: { reports: true, lists: true, company: true },
  ...load(),
  setIconBar(m) {
    set({ iconBar: m });
    save(get());
  },
  setWindowMode(m) {
    set({ windowMode: m });
    save(get());
  },
  setIconBarTab(t) {
    set({ iconBarTab: t });
    save(get());
  },
  setNavCollapsed(c) {
    set({ navCollapsed: c });
    save(get());
  },
  setNavGroupOpen(id, open) {
    const navClosed = { ...get().navClosed };
    if (open) delete navClosed[id];
    else navClosed[id] = true;
    set({ navClosed });
    save(get());
  },
}));

/** True in the Tabs workspace (View > Tabs). */
export function isTabsMode(): boolean {
  return useView.getState().windowMode === 'one';
}
