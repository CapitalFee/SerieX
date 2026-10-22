// Buttons, button bars, drop-down (menu) buttons and toolbars.
//
// Button variants: "primary" (accent filled: the main action, e.g. Save and close), "secondary"
// (white with a border; the default look, alias "normal"), "ghost" (no border until hover; alias
// "flat"), "danger" (red, destructive), "link" (text link). The old "default" variant (Windows
// default button) is drawn as primary. Access keys ("&Save" or accessKey="s") click the button with
// Alt+letter while its window is active; the underline appears while Alt is held, and the shortcut
// is added to the tooltip ("Save (Alt+S)").
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { parseAccessLabel } from './accessLabel';
import { useHotkeys } from './hotkeys';
import { MenuList, type MenuItem } from './menu';
import { Popup } from './Popup';

// Show access key underlines only while Alt is held (like Windows).
let altListening = false;
function listenAlt() {
  if (altListening || typeof window === 'undefined') return;
  altListening = true;
  const root = document.documentElement;
  const off = () => root.classList.remove('sx-alt');
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Alt') root.classList.add('sx-alt');
      else if (!e.altKey) off();
    },
    true,
  );
  window.addEventListener('keyup', (e) => e.key === 'Alt' && off(), true);
  window.addEventListener('blur', off);
  window.addEventListener('mousedown', off, true);
}

/** Visual style of a {@link Button}. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link' | 'normal' | 'default' | 'flat';

/** Renders a lucide icon component or any node (icons of buttons, toolbars, menus). */
export function renderIcon(icon: LucideIcon | ReactNode | undefined, size = 15, color?: string): ReactNode {
  if (!icon) return null;
  if (typeof icon === 'function' || (typeof icon === 'object' && icon !== null && '$$typeof' in (icon as object) && 'render' in (icon as object))) {
    const C = icon as LucideIcon;
    return <C size={size} color={color} strokeWidth={1.9} aria-hidden="true" />;
  }
  return <>{icon}</>;
}

/** Props of {@link Button}. Native button props pass through. */
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'accessKey'> {
  /**
   * Label with an optional `&` access key marker: "&Save && Close" shows "Save & Close" with S
   * underlined and Alt+S clicks it while its window is active. Use `children` for custom content.
   */
  label?: string;
  /** Access key letter (underlines its first occurrence in `label`); alternative to `&` in the label. */
  accessKey?: string;
  /** Look of the button (default "secondary"). See the file header. */
  variant?: ButtonVariant;
  /** A lucide icon component (e.g. `Save`) or any node, shown before the text. */
  icon?: LucideIcon | ReactNode;
  /** Smaller (24px) button. Same as size="sm". */
  small?: boolean;
  size?: 'sm' | 'md';
  /** Minimum width in px (default 72 for text buttons). */
  minWidth?: number;
  /** Shortcut shown in the tooltip ("Alt+S", "Ctrl+D"); added automatically for access keys. */
  shortcut?: string;
  /** Shows a spinner instead of the icon and disables the button. */
  busy?: boolean;
}

/** Push button with variants, icon and access key support (Alt+letter). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { label, accessKey, variant = 'secondary', icon, small, size, minWidth, shortcut, busy, className, style, children, type, title, disabled, ...rest },
  ref,
) {
  listenAlt();
  const btnRef = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => btnRef.current!);
  const parsed = label !== undefined ? parseAccessLabel(label, accessKey) : accessKey ? { node: null, text: '', key: accessKey.toLowerCase() } : null;
  const key = parsed?.key ?? null;
  useHotkeys(
    key
      ? {
          [`alt+${key}`]: () => {
            const b = btnRef.current;
            if (!b || b.disabled || b.offsetParent === null) return false;
            b.click();
          },
        }
      : {},
    [key],
    { element: btnRef },
  );
  const v = variant === 'default' ? 'primary' : variant === 'normal' ? 'secondary' : variant === 'flat' ? 'ghost' : variant;
  const iconOnly = !!icon && !label && !children;
  const cls =
    'sx-btn sx-btn-' +
    v +
    (variant === 'default' ? ' sx-btn-default' : variant === 'flat' ? ' sx-btn-flat' : '') +
    (small || size === 'sm' ? ' sx-btn-small' : '') +
    (iconOnly ? ' sx-btn-icon' : '') +
    (className ? ' ' + className : '');
  const hint = shortcut ?? (key ? `Alt+${key.toUpperCase()}` : undefined);
  const tip = title ?? (hint && parsed?.text ? `${parsed.text} (${hint})` : undefined);
  return (
    <button
      ref={btnRef}
      type={type ?? 'button'}
      className={cls}
      style={minWidth !== undefined ? { minWidth, ...style } : style}
      aria-keyshortcuts={key ? `Alt+${key.toUpperCase()}` : undefined}
      title={tip}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="sx-spinner sx-btn-spinner" aria-hidden="true" /> : icon ? <span className="sx-btn-ico">{renderIcon(icon, small || size === 'sm' ? 14 : 15)}</span> : null}
      {parsed?.node !== undefined && parsed?.node !== null && <span className="sx-btn-text">{parsed.node}</span>}
      {children}
    </button>
  );
});

/** Props of {@link ButtonBar}. */
export interface ButtonBarProps {
  children: ReactNode;
  /** Alignment of the buttons (default right, like dialog buttons). */
  align?: 'left' | 'right' | 'center' | 'between';
  className?: string;
  style?: CSSProperties;
}

/** Row of buttons with standard spacing (bottom of dialogs and forms). */
export function ButtonBar({ children, align = 'right', className, style }: ButtonBarProps) {
  return (
    <div className={`sx-buttonbar sx-justify-${align}` + (className ? ' ' + className : '')} style={style}>
      {children}
    </div>
  );
}

/** Props of {@link DropdownButton}. */
export interface DropdownButtonProps {
  /** Button text (with optional `&` access key). */
  label: string;
  items: MenuItem[];
  disabled?: boolean;
  /** Lucide icon component or node. */
  icon?: LucideIcon | ReactNode;
  /** Open the menu upwards (default: automatic, upwards when there is no room below). */
  up?: boolean;
  /** Align the menu with the right edge of the button. */
  alignEnd?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Toolbar look (ghost, icon + text) instead of a push button. */
  flat?: boolean;
  /** Push button look when not `flat` (default secondary). */
  variant?: 'primary' | 'secondary' | 'ghost';
  title?: string;
}

/** "Account ▾" style menu button (bottom of lists, center toolbars, "New ▾"). */
export function DropdownButton({ label, items, disabled, icon, up, alignEnd, className, style, flat, variant = 'secondary', title }: DropdownButtonProps) {
  listenAlt();
  const [open, setOpen] = useState<false | 'mouse' | 'key'>(false);
  const ref = useRef<HTMLButtonElement>(null);
  const parsed = parseAccessLabel(label);
  useHotkeys(
    parsed.key
      ? {
          [`alt+${parsed.key}`]: () => {
            if (disabled || !ref.current || ref.current.offsetParent === null) return false;
            setOpen('key');
          },
        }
      : {},
    [parsed.key, disabled],
    { element: ref },
  );
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={(flat ? 'sx-toolbtn' : `sx-btn sx-btn-${variant}`) + ' sx-dropdown' + (open ? ' sx-pressed' : '') + (className ? ' ' + className : '')}
        style={style}
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={!!open}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          setOpen((o) => (o ? false : 'mouse'));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || (e.key === 'ArrowUp' && up)) {
            e.preventDefault();
            setOpen('key');
          }
        }}
      >
        {icon && <span className="sx-btn-ico">{renderIcon(icon)}</span>}
        <span className="sx-btn-text">{parsed.node}</span>
        <ChevronDown size={14} className="sx-dd-arrow" aria-hidden="true" />
      </button>
      <Popup anchor={ref.current} open={!!open} onClose={() => setOpen(false)} preferAbove={up} align={alignEnd ? 'end' : 'start'} keepFocus={false}>
        <MenuList
          items={items}
          autoFocus
          onClose={() => {
            setOpen(false);
            ref.current?.focus();
          }}
        />
      </Popup>
    </>
  );
}

/** Props of {@link Toolbar}. */
export interface ToolbarProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** "bar" (default): gray strip with a bottom border; "plain": no background (inside cards). */
  variant?: 'bar' | 'plain';
  'aria-label'?: string;
}

/** Horizontal toolbar (centers, reports, registers). Put ToolbarButton / DropdownButton flat in it. */
export function Toolbar({ children, className, style, variant = 'bar', ...rest }: ToolbarProps) {
  return (
    <div role="toolbar" aria-label={rest['aria-label']} className={'sx-toolbar' + (variant === 'plain' ? ' sx-toolbar-plain' : '') + (className ? ' ' + className : '')} style={style}>
      {children}
    </div>
  );
}

/** Props of {@link ToolButton}. */
export interface ToolButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'accessKey'> {
  label?: string;
  /** Lucide icon component or node. */
  icon?: LucideIcon | ReactNode;
  /** Toggle buttons (e.g. "Hide Header") show a pressed state. */
  pressed?: boolean;
}

/** Flat toolbar button: small icon + text, highlighted on hover. (See also ToolbarButton.) */
export function ToolButton({ label, icon, pressed, className, children, type, ...rest }: ToolButtonProps) {
  const parsed = label !== undefined ? parseAccessLabel(label) : null;
  return (
    <button type={type ?? 'button'} className={'sx-toolbtn' + (pressed ? ' sx-pressed' : '') + (className ? ' ' + className : '')} aria-pressed={pressed} {...rest}>
      {icon && <span className="sx-btn-ico">{renderIcon(icon)}</span>}
      {parsed && <span className="sx-btn-text">{parsed.node}</span>}
      {children}
    </button>
  );
}

/** Props of {@link ToolbarButton}. */
export interface ToolbarButtonProps {
  label: string;
  /** Lucide icon component (preferred) or node. */
  icon?: LucideIcon | ReactNode;
  /** Icon color (default: the text color). */
  color?: string;
  onClick?: () => void;
  /** Opens this menu instead of calling onClick (a ▾ is shown). */
  menu?: MenuItem[];
  disabled?: boolean;
  /** Toggle look. */
  pressed?: boolean;
  /** "primary" draws an accent filled button (one main action per toolbar). */
  variant?: 'default' | 'primary';
  /** Shortcut shown in the tooltip ("Ctrl+D"). */
  shortcut?: string;
  /** Tooltip (default: label + shortcut). */
  title?: string;
  /** Hide the text and show only the icon (the label becomes the tooltip). */
  iconOnly?: boolean;
  /** CSS class "sx-tb-collapsible" lets the label hide on narrow windows (TxnFormFrame uses it). */
  className?: string;
  'aria-label'?: string;
}

/** Toolbar button with icon + label, optional menu (▾), toggle state and shortcut tooltip. */
export function ToolbarButton({ label, icon, color, onClick, menu, disabled, pressed, variant = 'default', shortcut, title, iconOnly, className, ...rest }: ToolbarButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const text = parseAccessLabel(label).text;
  // the label may be hidden on narrow toolbars (icons only), so the tooltip always names the action
  const tip = title ?? (shortcut ? `${text} (${shortcut})` : text);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={
          'sx-tbtn' +
          (variant === 'primary' ? ' sx-tbtn-primary' : '') +
          (pressed ? ' sx-pressed' : '') +
          (open ? ' sx-open' : '') +
          (iconOnly ? ' sx-tbtn-icononly' : '') +
          (className ? ' ' + className : '')
        }
        disabled={disabled}
        title={tip}
        aria-label={rest['aria-label'] ?? text}
        aria-haspopup={menu ? 'menu' : undefined}
        aria-expanded={menu ? open : undefined}
        aria-pressed={pressed}
        onMouseDown={(e) => {
          // keep focus in the form field (its value is committed by the action itself)
          if (menu) e.preventDefault();
        }}
        onClick={() => {
          if (menu) setOpen((o) => !o);
          else onClick?.();
        }}
        onKeyDown={(e) => {
          if (menu && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon && <span className="sx-tbtn-icon">{renderIcon(icon, 15, disabled ? undefined : color)}</span>}
        {!iconOnly && <span className="sx-tbtn-label">{text}</span>}
        {menu && <ChevronDown size={13} className="sx-tbtn-caret" aria-hidden="true" />}
      </button>
      {menu && (
        <Popup anchor={ref.current} open={open} onClose={() => setOpen(false)} keepFocus={false}>
          <MenuList items={menu} onClose={() => setOpen(false)} />
        </Popup>
      )}
    </>
  );
}

/** Thin vertical separator for toolbars. */
export function ToolSeparator() {
  return <span className="sx-toolsep" role="separator" aria-orientation="vertical" />;
}

/** Flexible space in a toolbar (pushes the following buttons to the right). */
export function ToolbarSpacer() {
  return <span className="sx-toolspacer" aria-hidden="true" />;
}
