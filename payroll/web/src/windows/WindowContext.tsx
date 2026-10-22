// useWindow(): API a window's content uses to talk to its MDI window.
import { createContext, useContext } from 'react';
import type { WindowKind } from './kinds';

export interface WindowApi {
  id: string;
  kind: WindowKind;
  props: Record<string, any>;
  /** Close this window. Runs the beforeClose hook unless force. Resolves false when the user cancelled. */
  close(force?: boolean): Promise<boolean>;
  setTitle(title: string): void;
  setDirty(dirty: boolean): void;
  /** Hook run before closing; resolve false to keep the window open. */
  setBeforeClose(fn: (() => Promise<boolean>) | null): void;
  focus(): void;
  isActive: boolean;
  /**
   * (extension) Tell the shell which record the window shows now, e.g. after a new
   * tax payment was saved: `setKeyProps({ id: 123 })`. Only the singleton key changes
   * (props are untouched), so opening that record later focuses this window.
   */
  setKeyProps(props: Record<string, any>): void;
}

export const WindowContext = createContext<WindowApi | null>(null);

export function useWindow(): WindowApi {
  const w = useContext(WindowContext);
  if (!w) throw new Error('useWindow() used outside of a window');
  return w;
}

/** Same as useWindow() but returns null outside a window (for components used in both places). */
export function useOptionalWindow(): WindowApi | null {
  return useContext(WindowContext);
}
