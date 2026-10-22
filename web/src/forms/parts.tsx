// Building blocks of transaction forms: header fields, totals, history panel, stamps.
import { useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fmtMoney } from '@/util/format';
import { HelpTip } from '@/components/HelpTip';
import { helpTipProps } from '@/components/inputs';
import '@/components/layers';

// ---------------------------------------------------------------------------
// Header fields

/** Props of {@link TxnHeaderField}. */
export interface TxnHeaderFieldProps {
  /** Uppercase label above the field ("CUSTOMER OR JOB", "DATE", "INVOICE #"). */
  label: ReactNode;
  children: ReactNode;
  /** Width of the field block (px or CSS). */
  width?: number | string;
  /** id of the control, so clicking the label focuses it. */
  htmlFor?: string;
  /** Align the label (e.g. right for amounts). */
  align?: 'left' | 'right';
  /**
   * "?" help tip after the label: a glossary term ("Undeposited Funds", "Terms", "Class",
   * "A/R account", "Billable"...) or a short explanation text.
   */
  help?: string;
  /** Shows a required marker after the label. */
  required?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** A form header field: small uppercase label (+ help tip) above the control; its inline error shows below. */
export function TxnHeaderField({ label, children, width, htmlFor, align, help, required, className, style }: TxnHeaderFieldProps) {
  return (
    <div className={'sx-hf' + (className ? ' ' + className : '')} style={{ width, ...style }}>
      <label className={'sx-label sx-label-flex' + (align === 'right' ? ' sx-align-right' : '')} htmlFor={htmlFor}>
        <span className="sx-label-text">{label}</span>
        {required && (
          <span className="sx-required" aria-label="required">
            *
          </span>
        )}
        {help && <HelpTip {...helpTipProps(help)} />}
      </label>
      <div className="sx-hf-ctl">{children}</div>
    </div>
  );
}

/** Props of {@link HeaderRow}. */
export interface HeaderRowProps {
  children: ReactNode;
  /** Push the following fields to the right (use a `<HeaderSpacer/>` for finer control). */
  className?: string;
  style?: CSSProperties;
}

/** Horizontal row of header fields with standard spacing (wraps on narrow windows). */
export function HeaderRow({ children, className, style }: HeaderRowProps) {
  return (
    <div className={'sx-hrow' + (className ? ' ' + className : '')} style={style}>
      {children}
    </div>
  );
}

/** Flexible space inside a HeaderRow (pushes the next fields to the right). */
export function HeaderSpacer() {
  return <div className="sx-hspacer" />;
}

// ---------------------------------------------------------------------------
// Totals

/** One line of {@link TotalsBlock}. */
export interface TotalsRow {
  key?: string;
  /** Left text ("Total", "PAYMENTS APPLIED", "BALANCE DUE"). */
  label: ReactNode;
  /** Amount (formatted 1,234.56). */
  value?: number | null;
  /** Custom right content instead of `value`. */
  display?: ReactNode;
  /** Content between label and amount (e.g. TAX item picker and "(8.25%)"). */
  control?: ReactNode;
  bold?: boolean;
  /** Larger text (BALANCE DUE). */
  big?: boolean;
  /** Line above the row. */
  separator?: boolean;
}

/** Props of {@link TotalsBlock}. */
export interface TotalsBlockProps {
  rows: TotalsRow[];
  /** Width of the amount column (default 110). */
  valueWidth?: number;
  className?: string;
  style?: CSSProperties;
}

/** Right-aligned totals of a form (TAX, Total, Payments Applied, BALANCE DUE). */
export function TotalsBlock({ rows, valueWidth = 110, className, style }: TotalsBlockProps) {
  return (
    <div className={'sx-totals' + (className ? ' ' + className : '')} style={{ ['--sx-totals-vw' as string]: `${valueWidth}px`, ...style }}>
      {rows.map((r, i) => (
        <div key={r.key ?? i} className={'sx-totals-row' + (r.bold ? ' sx-bold' : '') + (r.big ? ' sx-big' : '') + (r.separator ? ' sx-sep' : '')}>
          <span className="sx-totals-label">{r.label}</span>
          <span className="sx-totals-ctl">{r.control}</span>
          <span className="sx-totals-val">{r.display ?? (r.value === null || r.value === undefined ? '' : fmtMoney(r.value))}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// History panel

/** Props of {@link HistoryPanelFrame}. */
export interface HistoryPanelFrameProps {
  /** Tabs at the top ("Customer" | "Transaction"). */
  tabs?: { key: string; label: string }[];
  activeTab?: string;
  onTabChange?: (key: string) => void;
  /** Title band (e.g. the customer name, with an edit link). */
  title?: ReactNode;
  children?: ReactNode;
  /** Controlled open state. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** Initial state when uncontrolled (default open; remembered with persistKey). */
  defaultOpen?: boolean;
  persistKey?: string;
  /** Width when open (default 220). */
  width?: number;
}

function readOpen(key: string | undefined, def: boolean): boolean {
  if (!key) return def;
  try {
    const v = localStorage.getItem('sx.hist.' + key);
    return v === null ? def : v === '1';
  } catch {
    return def;
  }
}

/** Collapsible right-side panel of sales/purchase forms. Modules supply the content. */
export function HistoryPanelFrame({ tabs, activeTab, onTabChange, title, children, open, onToggle, defaultOpen = true, persistKey, width = 220 }: HistoryPanelFrameProps) {
  const [own, setOwn] = useState(() => readOpen(persistKey, defaultOpen));
  const isOpen = open ?? own;
  const toggle = () => {
    const n = !isOpen;
    if (open === undefined) setOwn(n);
    if (persistKey) {
      try {
        localStorage.setItem('sx.hist.' + persistKey, n ? '1' : '0');
      } catch {
        /* ignore */
      }
    }
    onToggle?.(n);
  };
  return (
    <aside className={'sx-histpanel' + (isOpen ? '' : ' sx-collapsed')} style={{ width: isOpen ? width : undefined }} aria-label="History">
      <button type="button" className="sx-histpanel-toggle" onClick={toggle} title={isOpen ? 'Hide history' : 'Show history'} aria-expanded={isOpen} aria-label={isOpen ? 'Hide history' : 'Show history'}>
        {isOpen ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronLeft size={14} aria-hidden="true" />}
      </button>
      {isOpen && (
        <div className="sx-histpanel-body">
          {tabs && tabs.length > 0 && (
            <div className="sx-histpanel-tabs" role="tablist">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={t.key === activeTab}
                  className={'sx-histpanel-tab' + (t.key === activeTab ? ' sx-active' : '')}
                  onClick={() => onTabChange?.(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {title && <div className="sx-histpanel-title">{title}</div>}
          <div className="sx-histpanel-content">{children}</div>
        </div>
      )}
    </aside>
  );
}

/** Props of {@link HistorySection}. */
export interface HistorySectionProps {
  /** Section heading ("SUMMARY", "RECENT TRANSACTIONS", "NOTES"). */
  title: ReactNode;
  /** Optional link at the right of the heading (e.g. "Edit Notes"). */
  action?: { label: string; onClick: () => void };
  children?: ReactNode;
}

/** A titled card inside the history panel. */
export function HistorySection({ title, action, children }: HistorySectionProps) {
  return (
    <section className="sx-histsec">
      <div className="sx-histsec-head">
        <span>{title}</span>
        {action && (
          <button type="button" className="sx-linkbtn" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
      <div className="sx-histsec-body">{children}</div>
    </section>
  );
}

/** Props of {@link HistoryRow}. */
export interface HistoryRowProps {
  label: ReactNode;
  value?: ReactNode;
  /** Makes the row a link (e.g. opens the transaction). */
  onClick?: () => void;
}

/** "label ........ value" row of the history panel (value may be a link). */
export function HistoryRow({ label, value, onClick }: HistoryRowProps) {
  return (
    <div className="sx-histrow">
      {onClick ? (
        <button type="button" className="sx-linkbtn sx-histrow-label" onClick={onClick}>
          {label}
        </button>
      ) : (
        <span className="sx-histrow-label">{label}</span>
      )}
      <span className="sx-histrow-value">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stamp

/** Stamps shown diagonally on forms. */
export type StampKind = 'PAID' | 'VOID' | 'PENDING' | 'RECEIVED';

/** Props of {@link Stamp}. */
export interface StampProps {
  kind: StampKind;
  className?: string;
  style?: CSSProperties;
}

/** Diagonal rubber stamp ("PAID", "VOID", "PENDING", "RECEIVED") over a form. */
export function Stamp({ kind, className, style }: StampProps) {
  return (
    <div className={`sx-stamp sx-stamp-${kind.toLowerCase()}` + (className ? ' ' + className : '')} style={style} role="img" aria-label={kind}>
      {kind}
    </div>
  );
}
