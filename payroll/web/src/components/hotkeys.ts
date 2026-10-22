// Keyboard shortcuts scoped to the active MDI window.
import { useEffect, useRef, type RefObject } from 'react';
import { useOptionalWindow } from '@/windows/WindowContext';
import { isDialogOpen, isPopupOpen, topDialog } from './layers';

/**
 * A hotkey handler. Return `false` to let the event continue (not handled); any other result
 * (nothing, true, null, a promise...) means handled.
 */
export type HotkeyHandler = (e: KeyboardEvent) => unknown;

/** Options of {@link useHotkeys}. */
export interface HotkeyOptions {
  /** Disable all keys of this hook (default enabled). */
  enabled?: boolean;
  /** Fire even when the component's window is not the active one. */
  global?: boolean;
  /**
   * Element that owns the keys. When a message box/dialog is open, keys only fire if this
   * element is inside the topmost dialog (so buttons inside custom dialogs keep their access keys).
   */
  element?: RefObject<HTMLElement | null>;
  /**
   * "capture" (default) runs before the controls inside the window; "bubble" runs after them,
   * so a key a control used (e.g. Escape closing a drop-down or reverting a field) is skipped.
   */
  phase?: 'capture' | 'bubble';
}

const MOD_ORDER = ['ctrl', 'alt', 'shift', 'meta'];
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  return: 'enter',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  pgup: 'pageup',
  pgdn: 'pagedown',
  space: ' ',
  plus: '+',
};

/** Normalizes "Ctrl+Shift+S" → "ctrl+shift+s" (modifiers in a fixed order). */
export function normalizeCombo(combo: string): string {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim());
  // "ctrl++" → key "+"
  const keyPart = combo.endsWith('++') ? '+' : parts[parts.length - 1];
  const mods = new Set(parts.slice(0, combo.endsWith('++') ? -2 : -1).map((m) => (m === 'control' ? 'ctrl' : m === 'cmd' ? 'meta' : m)));
  const key = KEY_ALIASES[keyPart] ?? keyPart;
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/**
 * The normalized combo of a keyboard event ("ctrl+insert", "alt+s", "escape").
 * Letters and digits come from `event.code`, so Alt+S works on macOS too.
 */
export function eventCombo(e: KeyboardEvent | React.KeyboardEvent): string {
  let key: string;
  let fromCode = true;
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else {
    key = (e.key ?? '').toLowerCase();
    fromCode = false;
  }
  if (key === 'esc') key = 'escape';
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  // Shift is part of punctuation keys ("+", "?"), so it only counts for letters, digits and named keys
  if (e.shiftKey && (fromCode || key.length > 1)) mods.push('shift');
  if (e.metaKey) mods.push('meta');
  return [...mods, key].join('+');
}

/**
 * Registers keyboard shortcuts that fire only while the component's MDI window is active
 * (or always, outside any window). Keys are like "ctrl+insert", "alt+s", "escape", "ctrl+h".
 * Handled events are prevented and stopped. Escape is ignored while a drop-down/menu is open,
 * and every key is ignored while a message box is open (unless `element` is inside it).
 *
 * The map may change every render; `deps` re-registers the listener (rarely needed).
 */
export function useHotkeys(map: Record<string, HotkeyHandler>, deps: unknown[] = [], opts: HotkeyOptions = {}): void {
  const win = useOptionalWindow();
  const state = useRef({ map, win, opts });
  state.current = { map, win, opts };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { map, win, opts } = state.current;
      if (opts.enabled === false || e.defaultPrevented || e.isComposing) return;
      const combo = eventCombo(e);
      let handler: HotkeyHandler | undefined;
      for (const [k, h] of Object.entries(map)) {
        if (normalizeCombo(k) === combo) {
          handler = h;
          break;
        }
      }
      if (!handler) return;
      if (isDialogOpen()) {
        const top = topDialog();
        const el = opts.element?.current;
        if (!el || !top || !top.contains(el)) return;
      } else {
        if (win && !win.isActive && !opts.global) return;
        // a key typed inside another window must not trigger this window's shortcuts
        const t = e.target as HTMLElement | null;
        const host = t && typeof t.closest === 'function' ? t.closest('[data-window-id], [data-sx-window]') : null;
        const hostId = host?.getAttribute('data-window-id') ?? host?.getAttribute('data-sx-window');
        if (win && host && hostId !== win.id && !opts.global) return;
      }
      if (combo === 'escape' && isPopupOpen()) return;
      const r = handler(e);
      if (r !== false) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const capture = state.current.opts.phase !== 'bubble';
    window.addEventListener('keydown', onKey, capture);
    return () => window.removeEventListener('keydown', onKey, capture);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
