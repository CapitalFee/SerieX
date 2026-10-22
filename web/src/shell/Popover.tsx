// Small fixed-position popover used by the shell (+ New panel, user menu, company
// switcher, navigation flyouts, tab menus). Rendered in document.body so no bar's
// stacking order can hide it. Closes on outside click, Escape, window resize and
// blur. Keyboard events it handles never reach the window manager.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type PopoverPlacement = 'below-start' | 'below-end' | 'right-start' | 'at-point';

interface PopoverProps {
  /** Element the popover is attached to (its rectangle decides the position). */
  anchor: () => HTMLElement | null;
  placement: PopoverPlacement;
  /** Viewport point for placement 'at-point' (context menus). */
  point?: { x: number; y: number };
  onClose(): void;
  className?: string;
  style?: CSSProperties;
  /** Gap between the anchor and the popover in px. */
  gap?: number;
  children: ReactNode;
  /** Pointer events inside these elements do not close the popover (besides the anchor). */
  keepOpenInside?: () => (HTMLElement | null)[];
  role?: string;
  ariaLabel?: string;
  onMouseLeave?: () => void;
  onMouseEnter?: () => void;
}

export function Popover({
  anchor,
  placement,
  point,
  onClose,
  className,
  style,
  gap = 6,
  children,
  keepOpenInside,
  role,
  ariaLabel,
  onMouseLeave,
  onMouseEnter,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const posRef = useRef(pos);
  posRef.current = pos;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const a = anchor();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pw = el.offsetWidth;
      const ph = el.offsetHeight;
      let left = 0;
      let top = 0;
      if (placement === 'at-point' && point) {
        left = point.x;
        top = point.y;
      } else if (a) {
        const r = a.getBoundingClientRect();
        if (placement === 'below-start') {
          left = r.left;
          top = r.bottom + gap;
        } else if (placement === 'below-end') {
          left = r.right - pw;
          top = r.bottom + gap;
        } else {
          left = r.right + gap;
          top = r.top;
        }
      }
      left = Math.max(8, Math.min(left, vw - pw - 8));
      top = Math.max(8, Math.min(top, vh - ph - 8));
      // compare with the rendered position (an updater can be replayed from an older state)
      const p = posRef.current;
      if (p && p.left === left && p.top === top) return;
      posRef.current = { left, top };
      setPos(posRef.current);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement, point?.x, point?.y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t)) return;
      if (anchor()?.contains(t)) return;
      for (const el of keepOpenInside?.() ?? []) if (el?.contains(t)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
      anchor()?.focus?.();
    };
    const onResize = () => closeRef.current();
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      ref={ref}
      className={`sx-pop${className ? ' ' + className : ''}`}
      style={{ ...style, left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
      role={role}
      aria-label={ariaLabel}
      onMouseLeave={onMouseLeave}
      onMouseEnter={onMouseEnter}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Move keyboard focus between the focusable items of a list/grid popover with the arrow keys. */
export function arrowFocus(e: React.KeyboardEvent, root: HTMLElement | null, selector: string): boolean {
  if (!root) return false;
  const items = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => !(el as HTMLButtonElement).disabled);
  if (!items.length) return false;
  const i = items.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
  else if (e.key === 'ArrowUp') next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  if (next < 0) return false;
  e.preventDefault();
  items[next].focus();
  return true;
}
