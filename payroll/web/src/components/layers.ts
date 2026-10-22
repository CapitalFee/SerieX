// Shared state of the top layers (drop-down popups and message boxes) so keyboard
// handlers know when a popup or a modal box owns the keyboard.
import '@/styles/components.css';

let popupCount = 0;

/** Called by Popup when it opens. */
export function popupOpened(): void {
  popupCount++;
}
/** Called by Popup when it closes. */
export function popupClosed(): void {
  popupCount = Math.max(0, popupCount - 1);
}
/** True while a drop-down list, calendar, or menu is open (Escape belongs to it). */
export function isPopupOpen(): boolean {
  return popupCount > 0;
}

/** CSS class of the element that holds every message box / modal dialog. */
export const DIALOG_LAYER_CLASS = 'sx-dlg-layer';

/** CSS class of a message box / dialog that stepped aside for a window (see {@link dialogsStepAside}). */
export const DIALOG_ASIDE_CLASS = 'sx-dlg-aside';

/** Message boxes / dialogs on screen (the ones that stepped aside for a window are left out). */
const VISIBLE_DIALOGS = `.${DIALOG_LAYER_CLASS} .sx-dlg-overlay:not(.${DIALOG_ASIDE_CLASS})`;

/** True while a message box or a dialog opened with showDialog() is on screen. */
export function isDialogOpen(): boolean {
  return document.querySelector(VISIBLE_DIALOGS) !== null;
}

/** The topmost open message box / dialog element (null when none). */
export function topDialog(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(VISIBLE_DIALOGS);
  return all.length ? all[all.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Dialogs step aside for windows opened from them
//
// Windows (MDI / tabs) live below the dialog layer, so a window opened while a showDialog() box is
// on screen (a picker's "+ Add new" opening the payroll item wizard, a link opening a record...)
// would be hidden behind the box. The window manager calls dialogsStepAside() when it opens or
// brings forward a window: the open boxes are hidden (their state is kept) while that window is
// open and come back, with the keyboard focus, when it closes (dialogsComeBack()).

interface DialogAsideHooks {
  stepAside(windowId: string): boolean;
  comeBack(windowId: string): void;
}

let asideHooks: DialogAsideHooks | null = null;

/** Installed once by the dialog host (components/dialogs). */
export function setDialogAsideHooks(hooks: DialogAsideHooks): void {
  asideHooks = hooks;
}

/** The open message boxes / dialogs step aside while window `windowId` is open; true when there were some. */
export function dialogsStepAside(windowId: string): boolean {
  return asideHooks ? asideHooks.stepAside(windowId) : false;
}

/** Window `windowId` closed: the boxes that stepped aside for it come back. */
export function dialogsComeBack(windowId: string): void {
  asideHooks?.comeBack(windowId);
}

/** z-index of drop-down lists, calendars and menus (MDI windows stay below 10000). */
export const Z_POPUP = 30000;
/** z-index of message boxes and showDialog() boxes (above popups). */
export const Z_DIALOG = 40000;

/**
 * z-index of a floating layer (drop-down list, calendar, menu, tooltip): above the popup or the
 * message box / showDialog box that contains its `anchor` (or, without an anchor, above the
 * topmost open box), so pickers and menus inside dialogs and popovers are not hidden under them;
 * `base` everywhere else.
 */
export function floatingZ(anchor: Element | null | undefined, base: number, above = 1): number {
  if (typeof document === 'undefined') return base;
  // a floating layer opened from inside another one (a picker in a quick create popover)
  const host = anchor ? anchor.closest<HTMLElement>('.sx-popup, .sx-bubble') : null;
  if (host && Number(host.style.zIndex)) return Math.max(base, Number(host.style.zIndex) + above);
  const ov = anchor ? anchor.closest<HTMLElement>(`.${DIALOG_LAYER_CLASS} .sx-dlg-overlay`) : topDialog();
  if (!ov) return base;
  const z = Number(ov.style.zIndex) || Z_DIALOG;
  return Math.max(base, z + above);
}
