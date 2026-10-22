// "?" help tips with plain-English explanations of accounting terms, and a light Tooltip.
//
//   <Label help="Undeposited Funds">Deposit to</Label>          (Label / TxnHeaderField take `help`)
//   <HelpTip term="Class" />                                     (text from util/glossary.ts)
//   <HelpTip title="Payment amount" text="What the customer paid you." />
//   <Tooltip content="Save and close (Alt+S)"><button>…</button></Tooltip>
import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { explain } from '@/util/glossary';
import { floatingZ, Z_POPUP } from './layers';

// ---------------------------------------------------------------------------
// Floating bubble (not a Popup: it never takes Escape or clicks from the form)

interface BubbleProps {
  anchor: HTMLElement | null;
  open: boolean;
  id?: string;
  children: ReactNode;
  /** Preferred side (default below, flips when there is no room). */
  placement?: 'top' | 'bottom';
  className?: string;
  maxWidth?: number;
}

function Bubble({ anchor, open, id, children, placement = 'bottom', className, maxWidth = 300 }: BubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: 'top' | 'bottom' } | null>(null);
  const posRef = useRef(pos);
  posRef.current = pos;
  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) {
      if (posRef.current !== null) setPos(null);
      return;
    }
    const r = anchor.getBoundingClientRect();
    const el = ref.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let side: 'top' | 'bottom' = placement;
    if (side === 'bottom' && r.bottom + 8 + h > vh - 4 && r.top - 8 - h > 4) side = 'top';
    if (side === 'top' && r.top - 8 - h < 4) side = 'bottom';
    const top = side === 'bottom' ? r.bottom + 7 : r.top - 7 - h;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(6, Math.min(vw - w - 6, left));
    // compare with the rendered position, not inside an updater (see Popup: avoids update loops)
    const p = posRef.current;
    if (p && p.left === left && p.top === top && p.side === side) return;
    setPos({ left, top, side });
  });
  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={'sx-bubble' + (pos ? ` sx-bubble-${pos.side}` : '') + (className ? ' ' + className : '')}
      style={{ position: 'fixed', zIndex: floatingZ(anchor, Z_POPUP + 50, 2), left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxWidth }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// HelpTip

/** Props of {@link HelpTip}. */
export interface HelpTipProps {
  /** Glossary term ("Undeposited Funds", "A/R account", "Class"...); its explanation is shown. */
  term?: string;
  /** Explanation text (overrides the glossary). */
  text?: ReactNode;
  /** Bold first line (default: the glossary term). */
  title?: ReactNode;
  /** Preferred side of the bubble (default below). */
  placement?: 'top' | 'bottom';
  /** Diameter of the "?" in px (default 14). */
  size?: number;
  className?: string;
}

/**
 * Small round "?" next to a label; hovering or clicking it shows a short plain-English
 * explanation. It is not a tab stop, so it never slows down keyboard data entry.
 * Renders nothing when the term is unknown and no text is given.
 */
export function HelpTip({ term, text, title, placement, size = 14, className }: HelpTipProps) {
  const entry = term ? explain(term) : undefined;
  const body = text ?? entry?.text;
  const head = title ?? entry?.term ?? (term && !entry ? term : undefined);
  const [open, setOpen] = useState<false | 'hover' | 'click'>(false);
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const id = useId();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (open !== 'click') return;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);
  if (!body) return null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        className={'sx-helptip' + (open ? ' sx-open' : '') + (className ? ' ' + className : '')}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.72) }}
        aria-label={head ? `What is ${typeof head === 'string' ? head : 'this'}?` : 'Help'}
        aria-describedby={open ? id : undefined}
        aria-expanded={!!open}
        onMouseDown={(e) => e.preventDefault() /* keep focus where it is */}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => (o === 'click' ? false : 'click'));
        }}
        onMouseEnter={() => {
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setOpen((o) => o || 'hover'), 180);
        }}
        onMouseLeave={() => {
          window.clearTimeout(timer.current);
          setOpen((o) => (o === 'hover' ? false : o));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        ?
      </button>
      <Bubble anchor={ref.current} open={!!open} id={id} placement={placement} className="sx-helpbubble">
        {head && <div className="sx-bubble-title">{head}</div>}
        <div className="sx-bubble-text">{body}</div>
      </Bubble>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tooltip

/** Props of {@link Tooltip}. */
export interface TooltipProps {
  /** Text of the tooltip; nothing is shown when empty. */
  content: ReactNode;
  /** One element that accepts mouse/focus handlers and a ref (a button, an icon...). */
  children: ReactElement;
  placement?: 'top' | 'bottom';
  /** Delay before showing, ms (default 350). */
  delay?: number;
}

/** Styled hover/focus tooltip for one element (use instead of `title` when the hint matters). */
export function Tooltip({ content, children, placement = 'bottom', delay = 350 }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const id = useId();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!isValidElement(children)) return children;
  const p = children.props as Record<string, any>;
  const show = (e: { currentTarget: EventTarget }) => {
    setAnchor(e.currentTarget as HTMLElement);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };
  const child = cloneElement(children as ReactElement<any>, {
    'aria-describedby': open && content ? id : p['aria-describedby'],
    onMouseEnter: (e: any) => {
      show(e);
      p.onMouseEnter?.(e);
    },
    onMouseLeave: (e: any) => {
      hide();
      p.onMouseLeave?.(e);
    },
    onFocus: (e: any) => {
      if ((e.currentTarget as HTMLElement).matches(':focus-visible')) show(e);
      p.onFocus?.(e);
    },
    onBlur: (e: any) => {
      hide();
      p.onBlur?.(e);
    },
    onMouseDown: (e: any) => {
      hide();
      p.onMouseDown?.(e);
    },
  });
  return (
    <>
      {child}
      <Bubble anchor={anchor} open={open && !!content} id={id} placement={placement} className="sx-tip" maxWidth={260}>
        {content}
      </Bubble>
    </>
  );
}
