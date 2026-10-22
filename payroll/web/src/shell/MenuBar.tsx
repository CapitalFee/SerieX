// Windows-style menu bar: drop-downs, submenus, access keys (Alt+letter, F10 / Alt
// alone arms the bar), arrow-key navigation, check / radio marks, disabled items.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseLabel, visibleItems, type MenuItem, type TopMenu } from './menus';

interface MenuBarProps {
  menus: TopMenu[];
  /** Content at the right end of the bar (maximized window buttons). */
  right?: ReactNode;
  /** Ignore mouse and keyboard (a modal dialog or the login box is open). */
  disabled?: boolean;
}

/** Label with its access key letter underlined. */
export function AccessLabel({ label }: { label: string }) {
  const { text, index } = parseLabel(label);
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <u>{text[index]}</u>
      {text.slice(index + 1)}
    </>
  );
}

const selectable = (it: MenuItem | undefined) => !!it && !it.separator;

function firstSelectable(items: MenuItem[]): number {
  return items.findIndex((it) => selectable(it) && !it.disabled) >= 0
    ? items.findIndex((it) => selectable(it) && !it.disabled)
    : items.findIndex(selectable);
}

function stepSelectable(items: MenuItem[], from: number, dir: 1 | -1): number {
  const n = items.length;
  if (!n) return -1;
  let i = from;
  for (let k = 0; k < n; k++) {
    i = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
    if (selectable(items[i])) return i;
  }
  return from;
}

/** Item lists of the open levels: [dropdown, submenu, sub-submenu...]. */
function levelItems(menus: TopMenu[], open: number | null, path: number[]): MenuItem[][] {
  if (open === null || !menus[open]) return [];
  const lv: MenuItem[][] = [visibleItems(menus[open].items)];
  for (let L = 0; L < path.length - 1; L++) {
    const it = lv[L][path[L]];
    if (!it || !it.submenu || it.disabled) break;
    lv.push(visibleItems(it.submenu));
  }
  return lv;
}

function keyChar(e: KeyboardEvent): string {
  if (e.code.startsWith('Key')) return e.code.slice(3).toLowerCase();
  if (e.code.startsWith('Digit')) return e.code.slice(5);
  return e.key.length === 1 ? e.key.toLowerCase() : '';
}

export function MenuBar({ menus, right, disabled }: MenuBarProps) {
  const [open, setOpen] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [path, setPath] = useState<number[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const topRefs = useRef<(HTMLDivElement | null)[]>([]);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const hoverTimer = useRef<number | undefined>(undefined);

  const levels = useMemo(() => levelItems(menus, open, path), [menus, open, path]);

  const st = useRef({ open, armed, path, menus, levels, disabled });
  st.current = { open, armed, path, menus, levels, disabled };

  const closeAll = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    setOpen(null);
    setArmed(null);
    setPath([]);
  }, []);

  const openMenu = useCallback((i: number, viaKeyboard: boolean) => {
    window.clearTimeout(hoverTimer.current);
    const items = visibleItems(st.current.menus[i]?.items ?? []);
    setOpen(i);
    setArmed(null);
    setPath([viaKeyboard ? firstSelectable(items) : -1]);
  }, []);

  /** Run an item: open its submenu or close the menus and run the action. */
  const activate = useCallback(
    (level: number, idx: number, viaKeyboard: boolean) => {
      const items = st.current.levels[level];
      const it = items?.[idx];
      if (!it || it.separator || it.disabled) return;
      if (it.submenu) {
        const sub = visibleItems(it.submenu);
        setPath([...st.current.path.slice(0, level), idx, viaKeyboard ? firstSelectable(sub) : -1]);
        return;
      }
      closeAll();
      if (it.action) {
        const run = it.action;
        window.setTimeout(run, 0);
      }
    },
    [closeAll],
  );

  // Keyboard while the bar is armed or a menu is open (capture: before everything else).
  useEffect(() => {
    if (open === null && armed === null) return;
    const onKey = (e: KeyboardEvent) => {
      const { open, armed, path, menus, levels } = st.current;
      const n = menus.length;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'Alt' || e.key === 'Control' || e.key === 'Shift' || e.key === 'Meta') return;
      // Alt+letter switches to another top menu.
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const ch = keyChar(e);
        const idx = menus.findIndex((m) => parseLabel(m.label).key === ch);
        if (idx >= 0) {
          openMenu(idx, true);
          stop();
        }
        return;
      }
      if (open === null) {
        if (armed === null) return;
        switch (e.key) {
          case 'ArrowLeft':
            setArmed((armed - 1 + n) % n);
            return stop();
          case 'ArrowRight':
            setArmed((armed + 1) % n);
            return stop();
          case 'ArrowDown':
          case 'ArrowUp':
          case 'Enter':
          case ' ':
            openMenu(armed, true);
            return stop();
          case 'Escape':
          case 'F10':
          case 'Tab':
            setArmed(null);
            return stop();
          default: {
            const ch = keyChar(e);
            const idx = menus.findIndex((m) => parseLabel(m.label).key === ch);
            if (idx >= 0) openMenu(idx, true);
            else setArmed(null);
            return stop();
          }
        }
      }
      const L = levels.length - 1;
      const items = levels[L] ?? [];
      const cur = path[L] ?? -1;
      switch (e.key) {
        case 'ArrowDown':
          setPath([...path.slice(0, L), stepSelectable(items, cur, 1)]);
          return stop();
        case 'ArrowUp':
          setPath([...path.slice(0, L), stepSelectable(items, cur, -1)]);
          return stop();
        case 'Home':
          setPath([...path.slice(0, L), stepSelectable(items, -1, 1)]);
          return stop();
        case 'End':
          setPath([...path.slice(0, L), stepSelectable(items, -1, -1)]);
          return stop();
        case 'ArrowRight': {
          const it = items[cur];
          if (it && it.submenu && !it.disabled) setPath([...path.slice(0, L + 1), firstSelectable(visibleItems(it.submenu))]);
          else openMenu((open + 1) % n, true);
          return stop();
        }
        case 'ArrowLeft':
          if (L > 0) setPath(path.slice(0, L));
          else openMenu((open - 1 + n) % n, true);
          return stop();
        case 'Enter':
        case ' ':
          if (cur >= 0) activate(L, cur, true);
          return stop();
        case 'Escape':
          if (L > 0) setPath(path.slice(0, L));
          else closeAll();
          return stop();
        case 'Tab':
        case 'F10':
          closeAll();
          return stop();
        default: {
          if (e.ctrlKey || e.metaKey) return stop();
          const ch = keyChar(e);
          if (!ch) return stop();
          const matches: number[] = [];
          items.forEach((it, i) => {
            if (selectable(it) && it.label && parseLabel(it.label).key === ch) matches.push(i);
          });
          if (matches.length === 1) {
            setPath([...path.slice(0, L), matches[0]]);
            activate(L, matches[0], true);
          } else if (matches.length > 1) {
            const next = matches.find((i) => i > cur) ?? matches[0];
            setPath([...path.slice(0, L), next]);
          }
          return stop();
        }
      }
    };
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return;
      closeAll();
    };
    const onBlur = () => closeAll();
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [open, armed, openMenu, activate, closeAll]);

  // Alt+letter / F10 / Alt alone when no menu is open (bubble: forms may claim Alt+S, Alt+N first).
  useEffect(() => {
    let altAlone = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        altAlone = !e.ctrlKey && !e.shiftKey && !e.metaKey;
        return;
      }
      altAlone = false;
      const { open, armed, menus, disabled } = st.current;
      if (disabled || e.defaultPrevented || open !== null || armed !== null) return;
      if (e.key === 'F10' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setArmed(0);
        e.preventDefault();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const ch = keyChar(e);
        if (!ch) return;
        const idx = menus.findIndex((m) => parseLabel(m.label).key === ch);
        if (idx >= 0) {
          openMenu(idx, true);
          e.preventDefault();
        }
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || !altAlone) return;
      altAlone = false;
      const { open, armed, disabled } = st.current;
      if (disabled) return;
      e.preventDefault();
      if (open !== null || armed !== null) closeAll();
      else setArmed(0);
    };
    const cancel = () => {
      altAlone = false;
    };
    // Capture phase: a field that handles Alt+key itself (Alt+Down on a drop-down) stops the
    // event before it bubbles to the window, but Alt is then no longer "alone".
    const onKeyCapture = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') altAlone = false;
    };
    window.addEventListener('keydown', onKeyCapture, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    window.addEventListener('pointerdown', cancel, true);
    return () => {
      window.removeEventListener('keydown', onKeyCapture, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('pointerdown', cancel, true);
    };
  }, [openMenu, closeAll]);

  useEffect(() => {
    if (disabled) closeAll();
  }, [disabled, closeAll]);

  const onHover = (level: number, idx: number) => {
    window.clearTimeout(hoverTimer.current);
    const items = st.current.levels[level];
    const it = items?.[idx];
    const cur = st.current.path;
    // Already highlighted with its submenu open: nothing to do.
    if (cur[level] === idx && cur.length > level + 1) return;
    const next = [...cur.slice(0, level), idx];
    setPath(next);
    if (it && it.submenu && !it.disabled) {
      hoverTimer.current = window.setTimeout(() => {
        setPath((p) => (p.length === level + 1 && p[level] === idx ? [...p, -1] : p));
      }, 200);
    }
  };

  const registerItem = (level: number, idx: number, el: HTMLDivElement | null) => {
    const k = `${level}:${idx}`;
    if (el) itemRefs.current.set(k, el);
    else itemRefs.current.delete(k);
  };

  return (
    <div className={`sx-menubar${disabled ? ' sx-menubar-disabled' : ''}`} ref={rootRef} role="menubar">
      {menus.map((m, i) => (
        <div
          key={m.label}
          ref={(el) => {
            topRefs.current[i] = el;
          }}
          role="menuitem"
          aria-haspopup="true"
          aria-expanded={open === i}
          className={`sx-menubar-item${open === i ? ' sx-open' : ''}${armed === i ? ' sx-armed' : ''}`}
          onPointerDown={(e) => {
            if (e.button !== 0 || disabled) return;
            e.preventDefault();
            if (open === i) closeAll();
            else openMenu(i, false);
          }}
          onPointerEnter={() => {
            if (open !== null && open !== i) openMenu(i, false);
          }}
        >
          <span>
            <AccessLabel label={m.label} />
          </span>
        </div>
      ))}
      <div className="sx-menubar-fill" />
      {right}
      {open !== null &&
        levels.map((items, L) => (
          <MenuPopup
            key={`${open}:${L}:${L === 0 ? '' : path[L - 1]}`}
            level={L}
            items={items}
            highlight={path[L] ?? -1}
            anchor={() => (L === 0 ? topRefs.current[open] ?? null : itemRefs.current.get(`${L - 1}:${path[L - 1]}`) ?? null)}
            onHover={onHover}
            onActivate={(lvl, idx) => activate(lvl, idx, false)}
            registerItem={registerItem}
          />
        ))}
    </div>
  );
}

interface PopupProps {
  level: number;
  items: MenuItem[];
  highlight: number;
  anchor(): HTMLElement | null;
  onHover(level: number, idx: number): void;
  onActivate(level: number, idx: number): void;
  registerItem(level: number, idx: number, el: HTMLDivElement | null): void;
}

function MenuPopup({ level, items, highlight, anchor, onHover, onActivate, registerItem }: PopupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const a = anchor();
    const el = ref.current;
    if (!a || !el) return;
    const r = a.getBoundingClientRect();
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if (level === 0) {
      left = r.left;
      top = r.bottom;
      if (left + pw > vw) left = Math.max(0, vw - pw - 2);
      if (top + ph > vh) top = Math.max(0, vh - ph - 2);
    } else {
      left = r.right - 3;
      top = r.top - 3;
      if (left + pw > vw) left = Math.max(0, r.left - pw + 3);
      if (top + ph > vh) top = Math.max(0, vh - ph - 2);
    }
    setPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, level]);

  return (
    <div
      ref={ref}
      className="sx-mbm"
      role="menu"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onPointerDown={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="sx-mbm-sep" role="separator" />
        ) : (
          <Fragment key={i}>
            <div
              ref={(el) => registerItem(level, i, el)}
              role="menuitem"
              aria-disabled={it.disabled || undefined}
              aria-haspopup={it.submenu ? 'true' : undefined}
              className={`sx-mbm-item${i === highlight ? ' sx-hl' : ''}${it.disabled ? ' sx-disabled' : ''}`}
              onPointerEnter={() => onHover(level, i)}
              onClick={() => onActivate(level, i)}
            >
              <span className="sx-mbm-check">{it.checked ? (it.radio ? <RadioDot /> : <CheckMark />) : null}</span>
              <span className="sx-mbm-label">
                <AccessLabel label={it.label ?? ''} />
              </span>
              <span className="sx-mbm-shortcut">{it.shortcut ?? ''}</span>
              <span className="sx-mbm-arrow">{it.submenu ? <SubArrow /> : null}</span>
            </div>
          </Fragment>
        ),
      )}
    </div>
  );
}

function CheckMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 6.2l2.6 2.6L10 3.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function RadioDot() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="2.6" fill="currentColor" />
    </svg>
  );
}

function SubArrow() {
  return (
    <svg width="8" height="9" viewBox="0 0 8 9" aria-hidden="true">
      <path d="M2 1l4 3.5L2 8z" fill="currentColor" />
    </svg>
  );
}
