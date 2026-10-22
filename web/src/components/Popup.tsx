// Floating layer attached to an element (drop-down lists, calendars, menus).
// Rendered in a portal so it is not clipped by MDI windows; follows its anchor on scroll/resize.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { floatingZ, popupClosed, popupOpened, Z_POPUP } from './layers';

/** Props of {@link Popup}. */
export interface PopupProps {
  /** Element the popup is attached to (positioned below it, or above when there is no room). */
  anchor?: HTMLElement | null;
  /** Fixed viewport point instead of an anchor (context menus). */
  point?: { x: number; y: number } | null;
  open: boolean;
  /** Called on a mouse press outside the popup and the anchor. */
  onClose?: () => void;
  children: ReactNode;
  /** Horizontal alignment with the anchor (default "start" = left edges aligned). */
  align?: 'start' | 'end';
  /** Prefer opening above the anchor (e.g. menu buttons at the bottom of a list). */
  preferAbove?: boolean;
  /** Make the popup at least as wide as the anchor. */
  matchWidth?: boolean;
  minWidth?: number;
  /** Prevent the popup from taking focus on mouse press (default true: keeps focus in the field). */
  keepFocus?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  role?: string;
}

let popupSeq = 0;

/**
 * A positioned floating layer in a portal. Counts as an open popup for Escape handling.
 * Clicks inside popups opened after this one (a drop-down list inside a popover), inside
 * message boxes and inside tooltips do not close it.
 */
export function Popup(props: PopupProps) {
  const { anchor, point, open, onClose, children, align = 'start', preferAbove, matchWidth, minWidth, keepFocus = true, className, style, id, role } = props;
  const ref = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);
  if (open && !seqRef.current) seqRef.current = ++popupSeq;
  if (!open && seqRef.current) seqRef.current = 0;
  const [pos, setPos] = useState<{ left: number; top: number; minWidth?: number } | null>(null);
  const posRef = useRef(pos);
  posRef.current = pos;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    popupOpened();
    return () => popupClosed();
  }, [open]);

  const place = () => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    let mw: number | undefined;
    if (point) {
      left = point.x;
      top = point.y;
      if (top + h > vh - 4) top = Math.max(4, point.y - h);
      if (left + w > vw - 4) left = Math.max(4, point.x - w);
    } else if (anchor) {
      const r = anchor.getBoundingClientRect();
      mw = matchWidth ? r.width : undefined;
      const width = Math.max(w, mw ?? 0);
      left = align === 'end' ? r.right - width : r.left;
      const below = r.bottom + 1;
      const above = r.top - h - 1;
      if (preferAbove) top = above >= 4 ? above : below;
      else top = below + h <= vh - 4 || above < 4 ? below : above;
      if (top + h > vh - 4) top = Math.max(4, vh - h - 4);
      if (left + width > vw - 4) left = Math.max(4, vw - width - 4);
      if (left < 4) left = 4;
    } else {
      return;
    }
    // Compare with the position on screen (not inside a state updater): when a lower-priority
    // update is pending, React replays updaters from an older base state, so an updater that
    // returns "the same object" can still produce a new object on every render (endless loop).
    // whole pixels: no sub-pixel ping-pong between renders
    left = Math.round(left);
    top = Math.round(top);
    const cur = posRef.current;
    if (cur && cur.left === left && cur.top === top && cur.minWidth === mw) return;
    setPos({ left, top, minWidth: mw });
  };

  useLayoutEffect(() => {
    if (open) place();
    else if (posRef.current !== null) setPos(null);
  });

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const onMove = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor?.contains(t)) return;
      const el = t instanceof Element ? t : t.parentElement;
      if (el?.closest('.sx-dlg-layer, .sx-bubble, .sx-toast-host')) return;
      const other = el?.closest<HTMLElement>('.sx-popup');
      if (other && Number(other.dataset.sxSeq ?? 0) > seqRef.current) return;
      onCloseRef.current?.();
    };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      document.removeEventListener('mousedown', onDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, anchor, point?.x, point?.y]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      className={'sx-popup' + (className ? ' ' + className : '')}
      data-sx-seq={seqRef.current}
      style={{
        position: 'fixed',
        // above the message box / dialog box it was opened from (pickers inside showDialog)
        zIndex: floatingZ(anchor ?? null, Z_POPUP),
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        minWidth: Math.max(pos?.minWidth ?? 0, minWidth ?? 0) || undefined,
        ...style,
      }}
      onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}
