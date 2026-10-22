// Global keyboard shortcuts. The listener runs in the window
// bubble phase, after window contents and the UI kit hotkeys: a key they handled
// (defaultPrevented) is left alone.
import { useEffect } from 'react';
import { useSession } from '@/state/session';
import { closeWindow, getActiveWindow, getTopModal, nextWindow, openWindow } from '@/windows/windowStore';
import { focusGlobalSearch } from './GlobalSearch';

/** Ctrl+letter keys the app uses inside windows: the browser default is suppressed. */
const RESERVED_CTRL = new Set(['KeyD', 'KeyE', 'KeyH', 'KeyM', 'KeyY', 'KeyQ', 'KeyG', 'KeyP', 'KeyS', 'KeyL', 'KeyU']);

/** Frame chrome (bars, navigation, tabs): Escape there never closes the active window. */
const CHROME = '.sx-appbar, .sx-nav, .sx-wtabs, .sx-menubar, .sx-topbar';

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (t as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
}

function isInFrame(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return true;
  if (t === document.body || t === document.documentElement) return true;
  return !!t.closest('.sx-frame');
}

export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const session = useSession.getState();
      if (session.login) return;
      // Keys typed in message boxes and popups outside the frame are not ours.
      if (!isInFrame(e.target)) return;
      const active = getActiveWindow();
      const modal = getTopModal();
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey;

      // Esc closes the active window when its content did not use the key.
      if (e.key === 'Escape' && plain && !e.shiftKey) {
        if (!active) return;
        if (e.target instanceof Element && e.target.closest(CHROME)) return;
        const winEl = e.target instanceof Element ? e.target.closest('[data-window-id]') : null;
        if (winEl && winEl.getAttribute('data-window-id') !== active.id) return;
        e.preventDefault();
        void closeWindow(active.id);
        return;
      }
      // Ctrl+F4 closes the active window.
      if (e.key === 'F4' && e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (active) void closeWindow(active.id);
        return;
      }
      // Ctrl+Tab / Ctrl+F6: next window (Shift: previous).
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'Tab' || e.key === 'F6')) {
        e.preventDefault();
        if (!modal) nextWindow(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'F1' && plain) {
        e.preventDefault();
        if (!modal) openWindow('about', { help: true });
        return;
      }
      // Everything below needs an open company and no modal dialog.
      if (modal || !session.companyId) return;

      // Ctrl+K (Cmd+K) and "/" focus the global search box.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') {
        e.preventDefault();
        focusGlobalSearch();
        return;
      }
      if (e.key === '/' && plain && !isEditable(e.target)) {
        e.preventDefault();
        focusGlobalSearch();
        return;
      }
      // Typing in the search box keeps the normal text keys (Ctrl+A selects all...).
      if (e.target instanceof Element && e.target.closest('.sx-gsearch')) return;

      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        const t = e.target as HTMLElement | null;
        const inTextArea = !!t && (t.tagName === 'TEXTAREA' || t.isContentEditable);
        switch (e.code) {
          case 'KeyI':
            e.preventDefault();
            openWindow('invoice');
            return;
          case 'KeyA':
            if (inTextArea) return;
            e.preventDefault();
            openWindow('chartOfAccounts');
            return;
          case 'KeyJ':
            e.preventDefault();
            openWindow('customerCenter');
            return;
          case 'KeyR':
            e.preventDefault();
            openWindow('useRegister');
            return;
          case 'KeyF':
            e.preventDefault();
            openWindow('find');
            return;
          case 'KeyT':
            e.preventDefault();
            openWindow('memorizedTxns');
            return;
          case 'KeyW':
            e.preventDefault();
            openWindow('writeCheck');
            return;
          default:
            if (RESERVED_CTRL.has(e.code)) e.preventDefault();
            return;
        }
      }
      // Alt+W: Write Checks (browsers keep Ctrl+W for closing the tab).
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyW') {
        e.preventDefault();
        openWindow('writeCheck');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
