// Layout helpers: Tabs, Splitter, GroupBox, Spinner, EmptyState.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button, renderIcon } from './buttons';
import './layers';

function readStored(key: string | undefined): number | null {
  if (!key) return null;
  try {
    const v = localStorage.getItem('sxp.split.' + key);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tabs

/** One tab of {@link Tabs}. */
export interface TabDef {
  key: string;
  label: ReactNode;
  disabled?: boolean;
  /** Content shown when the tab is active (or pass `children` to Tabs). */
  content?: ReactNode;
  title?: string;
}

/** Props of {@link Tabs}. */
export interface TabsProps {
  tabs: TabDef[];
  active: string;
  onChange(key: string): void;
  /** Content for the active tab when tabs have no `content`. */
  children?: ReactNode;
  /**
   * "folder": tabs over a bordered white panel (dialogs, centers, Expenses/Items);
   * "strip": underlined tabs without a panel border (page-level tabs, filters).
   */
  variant?: 'folder' | 'strip';
  /** Content panel takes the remaining height (flex column). */
  fill?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Extra content at the right end of the tab strip. */
  right?: ReactNode;
  'aria-label'?: string;
}

/** Tab strip with content panel. Arrow keys move between tabs. */
export function Tabs({ tabs, active, onChange, children, variant = 'folder', fill, className, style, right, ...rest }: TabsProps) {
  const cur = tabs.find((t) => t.key === active);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const enabled = tabs.filter((t) => !t.disabled);
  return (
    <div className={`sx-tabs sx-tabs-${variant}` + (fill ? ' sx-fill' : '') + (className ? ' ' + className : '')} style={style}>
      <div className="sx-tabstrip" role="tablist" aria-label={rest['aria-label']}>
        {tabs.map((t) => (
          <button
            key={t.key}
            ref={(el) => (refs.current[t.key] = el)}
            type="button"
            role="tab"
            aria-selected={t.key === active}
            tabIndex={t.key === active ? 0 : -1}
            disabled={t.disabled}
            title={t.title}
            className={'sx-tab' + (t.key === active ? ' sx-active' : '')}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              const i = enabled.findIndex((x) => x.key === t.key);
              const n = enabled[(i + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
              if (n) {
                onChange(n.key);
                refs.current[n.key]?.focus();
              }
              e.preventDefault();
            }}
          >
            {t.label}
          </button>
        ))}
        {right && <div className="sx-tabstrip-right">{right}</div>}
      </div>
      <div className="sx-tabpanel" role="tabpanel">
        {cur?.content ?? children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Splitter

/** Props of {@link Splitter}. */
export interface SplitterProps {
  /** "horizontal": panes side by side (vertical bar); "vertical": stacked (horizontal bar). */
  direction?: 'horizontal' | 'vertical';
  /** Initial size of the first pane in px. */
  initial: number;
  /** Minimum size of the first pane (default 80). */
  min?: number;
  /** Minimum size of the second pane (default 80). */
  minSecond?: number;
  /** Remember the size in localStorage under this key. */
  persistKey?: string;
  /** Exactly two children: first and second pane. */
  children: [ReactNode, ReactNode];
  className?: string;
  style?: CSSProperties;
}

/** Two panes with a draggable divider (centers: list on the left, details on the right). */
export function Splitter({ direction = 'horizontal', initial, min = 80, minSecond = 80, persistKey, children, className, style }: SplitterProps) {
  const [size, setSize] = useState(() => readStored(persistKey) ?? initial);
  const ref = useRef<HTMLDivElement>(null);
  const horiz = direction === 'horizontal';
  useEffect(() => {
    if (!persistKey) return;
    try {
      localStorage.setItem('sxp.split.' + persistKey, String(Math.round(size)));
    } catch {
      /* ignore */
    }
  }, [size, persistKey]);
  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const box = ref.current!.getBoundingClientRect();
    const total = horiz ? box.width : box.height;
    const move = (ev: MouseEvent) => {
      const p = horiz ? ev.clientX - box.left : ev.clientY - box.top;
      setSize(Math.max(min, Math.min(total - minSecond - 5, p)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = horiz ? 'col-resize' : 'row-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div ref={ref} className={`sx-splitter sx-split-${horiz ? 'h' : 'v'}` + (className ? ' ' + className : '')} style={style}>
      <div className="sx-pane" style={horiz ? { width: size } : { height: size }}>
        {children[0]}
      </div>
      <div
        className="sx-split-bar"
        role="separator"
        aria-orientation={horiz ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(size)}
        tabIndex={-1}
        onMouseDown={startDrag}
      />
      <div className="sx-pane sx-pane-rest">{children[1]}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GroupBox, Spinner, EmptyState

/** Props of {@link GroupBox}. */
export interface GroupBoxProps {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Bordered group with a title in the border (Windows fieldset). */
export function GroupBox({ title, children, className, style }: GroupBoxProps) {
  return (
    <fieldset className={'sx-group' + (className ? ' ' + className : '')} style={style}>
      {title !== undefined && <legend>{title}</legend>}
      {children}
    </fieldset>
  );
}

/** Props of {@link Spinner}. */
export interface SpinnerProps {
  /** Text next to the spinner (default none). */
  label?: string;
  /** Center in the parent (absolute overlay style). */
  center?: boolean;
  size?: number;
}

/** Small busy indicator. */
export function Spinner({ label, center, size = 16 }: SpinnerProps) {
  return (
    <div className={'sx-spinner-wrap' + (center ? ' sx-center' : '')} role="status" aria-live="polite">
      <span className="sx-spinner" style={{ width: size, height: size }} aria-hidden="true" />
      {label ? <span className="sx-spinner-label">{label}</span> : <span className="sx-visually-hidden">Loading</span>}
    </div>
  );
}

/** Props of {@link EmptyState}. */
export interface EmptyStateProps {
  /** Explanation ("You have no customers yet. Customers are the people and businesses you sell to."). */
  message?: ReactNode;
  /** Bold first line ("No customers yet"). */
  title?: ReactNode;
  /** Lucide icon component (e.g. `Users`) or any node, shown in a soft circle. */
  icon?: LucideIcon | ReactNode;
  /** Main action button (accent colored), e.g. { label: 'Add customer', onClick }. */
  action?: { label: string; onClick: () => void; icon?: LucideIcon | ReactNode };
  /** Second action (plain button). */
  secondaryAction?: { label: string; onClick: () => void; icon?: LucideIcon | ReactNode };
  /** Smaller version for panels and dropdowns. */
  compact?: boolean;
  /** Extra content (links...) under the actions. */
  children?: ReactNode;
  className?: string;
}

/** Centered empty-list message that explains and offers the main action. */
export function EmptyState({ message, title, icon, action, secondaryAction, compact, children, className }: EmptyStateProps) {
  return (
    <div className={'sx-empty' + (compact ? ' sx-compact' : '') + (className ? ' ' + className : '')}>
      {icon && <div className="sx-empty-icon">{renderIcon(icon, compact ? 18 : 24)}</div>}
      {title && <div className="sx-empty-title">{title}</div>}
      {message && <div className="sx-empty-msg">{message}</div>}
      {(action || secondaryAction) && (
        <div className="sx-empty-actions">
          {action && <Button variant="primary" icon={action.icon} label={action.label} onClick={action.onClick} />}
          {secondaryAction && <Button icon={secondaryAction.icon} label={secondaryAction.label} onClick={secondaryAction.onClick} />}
        </div>
      )}
      {children && <div className="sx-empty-actions">{children}</div>}
    </div>
  );
}
