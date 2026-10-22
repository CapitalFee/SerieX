// Windows-style menus: MenuList (used by DropdownButton, context menus and toolbars),
// ContextMenu and the imperative showContextMenu().
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { parseAccessLabel } from './accessLabel';
import { Popup } from './Popup';

/** One entry of a menu. `separator: true` draws a line; `items` makes a submenu. */
export interface MenuItem {
  /** Text; `&` marks the access key ("&Delete"). */
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Shows a check mark in the left gutter. */
  checked?: boolean;
  /** Right-aligned shortcut text ("Ctrl+D"). */
  shortcut?: string;
  separator?: boolean;
  /** Submenu entries. */
  items?: MenuItem[];
  /** Small icon in the gutter (instead of a check mark). */
  icon?: ReactNode;
  /** Omit the entry. */
  hidden?: boolean;
}

/** Props of {@link MenuList}. */
export interface MenuListProps {
  items: MenuItem[];
  /** Called after an entry was chosen or the menu was dismissed with Escape. */
  onClose(): void;
  /** Focus the menu so arrow keys work (when opened from the keyboard). */
  autoFocus?: boolean;
  /** Highlight the first entry (submenus opened with the keyboard). */
  selectFirst?: boolean;
  /** Submenus: Left/Escape go back to the parent menu instead of closing everything. */
  onBack?: () => void;
  className?: string;
}

/** A vertical Windows-style menu with keyboard navigation and submenus. */
export function MenuList({ items, onClose, autoFocus = true, selectFirst, onBack, className }: MenuListProps) {
  const shown = items.filter((i) => !i.hidden);
  const [active, setActive] = useState(() => (selectFirst ? shown.findIndex((i) => !i.separator && !i.disabled) : -1));
  const [subOpen, setSubOpen] = useState(-1);
  const [subByKey, setSubByKey] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const selectable = (i: number) => i >= 0 && i < shown.length && !shown[i].separator && !shown[i].disabled;
  const step = (dir: 1 | -1) => {
    let i = active;
    for (let n = 0; n < shown.length; n++) {
      i = (i + dir + shown.length) % shown.length;
      if (selectable(i)) {
        setActive(i);
        return;
      }
    }
  };
  const choose = (i: number) => {
    const it = shown[i];
    if (!it || it.disabled || it.separator) return;
    if (it.items) {
      setSubOpen(i);
      setSubByKey(true);
      return;
    }
    onClose();
    it.onClick?.();
  };

  return (
    <div
      ref={ref}
      className={'sx-menu' + (className ? ' ' + className : '')}
      role="menu"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (subOpen >= 0) return; // the submenu handles keys
        const k = e.key;
        if (k === 'ArrowDown') step(1);
        else if (k === 'ArrowUp') step(-1);
        else if (k === 'Home') {
          setActive(-1);
          step(1);
        } else if (k === 'Enter' || k === ' ') choose(active);
        else if (k === 'ArrowRight' && shown[active]?.items && !shown[active].disabled) {
          setSubOpen(active);
          setSubByKey(true);
        }
        else if (k === 'Escape' || k === 'ArrowLeft') (onBack ?? onClose)();
        else if (k === 'Tab') onClose();
        else if (k.length === 1 && /\w/.test(k)) {
          // access key / first letter
          const lower = k.toLowerCase();
          const idx = shown.findIndex((it, i) => selectable(i) && it.label && parseAccessLabel(it.label).key === lower);
          const idx2 = idx >= 0 ? idx : shown.findIndex((it, i) => selectable(i) && it.label?.replace(/&/g, '').toLowerCase().startsWith(lower));
          if (idx2 >= 0) choose(idx2);
          else return;
        } else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {shown.map((it, i) =>
        it.separator ? (
          <div key={i} className="sx-menu-sep" role="separator" />
        ) : (
          <div
            key={i}
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            aria-checked={it.checked ?? undefined}
            aria-haspopup={it.items ? 'menu' : undefined}
            className={'sx-menu-item' + (it.disabled ? ' sx-disabled' : '') + (i === active ? ' sx-active' : '')}
            onMouseEnter={() => {
              setActive(i);
              setSubOpen(it.items && !it.disabled ? i : -1);
              setSubByKey(false);
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              choose(i);
            }}
          >
            <span className="sx-menu-gutter">{it.icon ?? (it.checked ? '✓' : '')}</span>
            <span className="sx-menu-label">{it.label ? parseAccessLabel(it.label).node : ''}</span>
            <span className="sx-menu-shortcut">{it.shortcut ?? ''}</span>
            <span className="sx-menu-arrow">{it.items ? '▶' : ''}</span>
            {it.items && subOpen === i && (
              <div className="sx-submenu">
                <MenuList
                  items={it.items}
                  onClose={() => {
                    setSubOpen(-1);
                    onClose();
                  }}
                  autoFocus={subByKey}
                  selectFirst={subByKey}
                  onBack={() => {
                    setSubOpen(-1);
                    ref.current?.focus({ preventScroll: true });
                  }}
                />
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}

/** Props of {@link ContextMenu}. */
export interface ContextMenuProps {
  /** Viewport coordinates (event.clientX / clientY). */
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}

/** A context menu at a point (declarative form; see also showContextMenu()). */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  return (
    <Popup open point={{ x, y }} onClose={onClose}>
      <MenuList items={items} onClose={onClose} />
    </Popup>
  );
}

// ---------------------------------------------------------------------------
// Imperative context menu (rendered by <DialogHost/>)

type CtxState = { x: number; y: number; items: MenuItem[] } | null;
let ctxState: CtxState = null;
const ctxListeners = new Set<() => void>();
const emit = () => ctxListeners.forEach((l) => l());

/**
 * Opens a context menu at the mouse position of `e` (a mouse event; its default is prevented)
 * or at `{x, y}`. Only one context menu is open at a time.
 */
export function showContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void } | { x: number; y: number }, items: MenuItem[]): void {
  let x: number, y: number;
  if ('clientX' in e) {
    e.preventDefault?.();
    x = e.clientX;
    y = e.clientY;
  } else {
    x = e.x;
    y = e.y;
  }
  if (!ctxState) ctxPrevFocus = document.activeElement as HTMLElement | null;
  ctxState = { x, y, items };
  emit();
}

let ctxPrevFocus: HTMLElement | null = null;

/** Closes the imperative context menu (focus returns to where it was). */
export function hideContextMenu(): void {
  if (!ctxState) return;
  ctxState = null;
  emit();
  const prev = ctxPrevFocus;
  ctxPrevFocus = null;
  if (prev && prev.isConnected && prev !== document.body) prev.focus({ preventScroll: true });
}

/** Renders the menu opened by showContextMenu(). Mounted by DialogHost. */
export function ContextMenuHost() {
  const s = useSyncExternalStore(
    (l) => {
      ctxListeners.add(l);
      return () => ctxListeners.delete(l);
    },
    () => ctxState,
  );
  if (!s) return null;
  return <ContextMenu key={`${s.x},${s.y}`} x={s.x} y={s.y} items={s.items} onClose={hideContextMenu} />;
}
