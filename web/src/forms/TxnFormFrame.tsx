// Standard transaction form chrome (a clean desktop-application look):
//
//   ◄ ► │ New  Save  Print  Delete ▾  Make a copy  Memorize  More ▾ │ form actions …
//   ─────────────────────────────────────────────────────────────────────────────────────────────
//   Invoice  [Paid]  (Unsaved changes)                                 titleRight (template…)
//   [error banner: problems of the last save, click to jump to the field]
//   header slot (CUSTOMER OR JOB, DATE, INVOICE #…)
//   lines slot (grid; takes the remaining height; data-field="lines" for "lines" errors)
//   footer slot (customer message, memo, tax picker, detailed totals)
//   ─────────────────────────────────────────────────────────────────────────────────────────────
//   sticky: bottomLeft  Clear│Revert        Subtotal  Tax  Total  BALANCE DUE   Save and new  [Save and close]
//
// The body scrolls between the toolbar and the sticky footer, so the totals and the Save buttons
// stay visible. Form-specific actions (Receive payment, Create invoice, Apply credits…) come from
// `extraButtons`; Transaction history / journal, Find and `reportButtons` are in "More ▾".
// Print is shown only when `onPrint` is given (no controls that do nothing; Ctrl+P prints too).
// When the toolbar is too narrow its labels collapse step by step (Make a copy, Memorize, Print
// and More first, then Delete and Mark as pending, then New and Save, the form actions last). The light blue-gray
// form tint and the big title stay for familiarity. Inline errors of useTxnForm are provided to
// every control (FormErrorsProvider) and summarized in the banner.
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import {
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  Copy,
  FilePlus2,
  Hourglass,
  MoreHorizontal,
  Printer,
  Save,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { openWindow } from '@/windows/windowStore';
import { Button, ToolbarButton, ToolSeparator, ToolbarSpacer } from '@/components/buttons';
import { useHotkeys } from '@/components/hotkeys';
import type { MenuItem } from '@/components/menu';
import { Spinner } from '@/components/layout';
import { ErrorBanner, FormErrorsProvider } from '@/components/formErrors';
import { StatusPill } from '@/components/display';
import { fmtMoney } from '@/util/format';
import { Stamp, type StampKind } from './parts';
import type { TxnForm } from './useTxnForm';

/** A toolbar button (form-specific buttons are passed by the module, e.g. "Receive payment"). */
export interface RibbonButton {
  key?: string;
  label: string;
  /** A lucide icon component or any node. */
  icon?: LucideIcon | ReactNode;
  /** Icon color (lucide icons; default: the text color). */
  color?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Shows a ▾ and opens this menu instead of onClick. */
  menu?: MenuItem[];
  /** Toggle look (pressed). */
  pressed?: boolean;
  title?: string;
  /** Shortcut shown in the tooltip ("Ctrl+P"). */
  shortcut?: string;
  /** Draw as the accented primary action of the toolbar. */
  primary?: boolean;
  /** Hide it (instead of disabling: controls that cannot be used are not shown). */
  hidden?: boolean;
}

/** One total of the sticky footer ("Total 1,082.50"). */
export interface FooterTotal {
  key?: string;
  label: ReactNode;
  /** Amount (formatted 1,234.56) or any node. */
  value: number | ReactNode;
  /** Bigger, bold (the last important number: Total / Balance due). */
  strong?: boolean;
  /** Color of the value. */
  tone?: 'danger' | 'success' | 'muted';
}

/** Props of {@link TxnFormFrame}. */
export interface TxnFormFrameProps {
  /** State and actions from useTxnForm(). */
  form: TxnForm;
  /** Big title at the top-left of the form ("Invoice", "Bill", "Check"). */
  title: string;
  /** Status pill next to the title ("Paid", "Open", "Overdue", "Pending", "Void"...). */
  status?: string | null;
  /** Content right of the title (e.g. the TEMPLATE picker, "Bill received" checkbox). */
  titleRight?: ReactNode;
  /** Header fields (customer, date, number, addresses...). */
  header?: ReactNode;
  /** Lines area (grid); it takes the remaining height. */
  lines?: ReactNode;
  /** Footer inside the scrolling body (customer message, memo, tax picker, detailed totals). */
  footer?: ReactNode;
  /** Extra content after the footer. */
  children?: ReactNode;
  /** Totals always visible in the sticky bottom bar (array of totals, or any node). */
  totals?: FooterTotal[] | ReactNode;
  /** Right side panel (HistoryPanelFrame). */
  sidePanel?: ReactNode;
  stamp?: StampKind | null;
  /** Show "Mark as pending" (sales forms: invoices, sales receipts). */
  showPending?: boolean;
  /** Form-specific toolbar buttons (after the standard ones). */
  extraButtons?: RibbonButton[];
  /** Extra entries of the "More ▾" menu (reports about this transaction). */
  reportButtons?: RibbonButton[];
  /** Print handler (the Print button is shown only when given). */
  onPrint?: () => void;
  /** Find handler (default: opens the Find window for this transaction type; in "More ▾"). */
  onFind?: () => void;
  /** Allow Delete (default true). */
  canDelete?: boolean;
  /** Allow Void (default true; disabled automatically for new or voided transactions). */
  canVoid?: boolean;
  /** Content at the left of the sticky bottom bar (e.g. "Clear splits", "To be printed"). */
  bottomLeft?: ReactNode;
  /** Hide "Save and new" (e.g. bill payments). */
  hideSaveNew?: boolean;
  /** Read-only form (e.g. a voided or reconciled view): disables saving buttons. */
  readOnly?: boolean;
  className?: string;
}

function isNodeTotals(t: TxnFormFrameProps['totals']): t is ReactNode {
  return !Array.isArray(t);
}

/** The standard transaction form window content. */
export function TxnFormFrame(props: TxnFormFrameProps) {
  const { form, title, status, titleRight, header, lines, footer, children, totals, sidePanel, stamp, showPending, extraButtons, reportButtons, onPrint, onFind, bottomLeft, hideSaveNew, readOnly, className } =
    props;
  const canDelete = props.canDelete !== false;
  const canVoid = props.canVoid !== false;
  const t = form.txn;
  const isNew = form.isNew;
  const busy = form.saving || form.loading;
  const find = onFind ?? (() => openWindow('find', { type: form.type }));
  const bodyRef = useRef<HTMLDivElement>(null);
  const printRef = useRef(onPrint);
  printRef.current = onPrint;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Ctrl+P prints the form (when it can be printed); otherwise the key is left alone
  const print = () => {
    const p = printRef.current;
    if (!p || busyRef.current) return false;
    p();
    return true;
  };
  useHotkeys({ 'ctrl+p': print, 'meta+p': print });

  // Delete / Void: one menu (or a single button when only one applies)
  const voidOk = canVoid && !isNew && !t.voided && !readOnly;
  const deleteItems: MenuItem[] = [
    ...(canVoid ? [{ label: '&Void', disabled: !voidOk, onClick: () => void form.voidTxn() }] : []),
    ...(canDelete ? [{ label: '&Delete', shortcut: 'Ctrl+D', disabled: !!readOnly, onClick: () => void form.remove() }] : []),
  ];

  const more: MenuItem[] = [
    { label: 'Transaction &history', shortcut: 'Ctrl+H', disabled: isNew, onClick: () => form.history() },
    { label: 'Transaction &journal', shortcut: 'Ctrl+Y', disabled: isNew, onClick: () => form.journal() },
    ...(reportButtons ?? [])
      .filter((b) => !b.hidden)
      .map<MenuItem>((b) => ({ label: b.label, disabled: b.disabled, onClick: b.onClick, items: b.menu, shortcut: b.shortcut })),
    { separator: true },
    { label: '&Find transactions…', shortcut: 'Ctrl+F', onClick: find },
  ];

  // Toolbar labels collapse to icons only when the buttons do not fit (standard buttons first,
  // then the form-specific ones), so wide enough windows keep "icon + text".
  const barRef = useRef<HTMLDivElement>(null);
  const barKey = [
    !!onPrint,
    showPending,
    t.isPending,
    deleteItems.length,
    (extraButtons ?? []).filter((b) => !b.hidden).map((b) => b.label + (b.menu ? '▾' : '')).join(','),
  ].join('|');
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const fits = () => bar.scrollWidth <= bar.clientWidth + 1;
    // collapse step by step: rarely used buttons, then the standard ones, then the form actions
    const fit = () => {
      bar.classList.remove('sx-tb-c1', 'sx-tb-c2', 'sx-tb-c3', 'sx-tb-c4');
      for (const c of ['sx-tb-c1', 'sx-tb-c2', 'sx-tb-c3', 'sx-tb-c4']) {
        if (fits()) return;
        bar.classList.add(c);
      }
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [barKey]);

  const errCount = Object.keys(form.fieldErrors).length + (form.formError ? 1 : 0);
  const linesBad = !!form.fieldErrors.lines;

  return (
    <div ref={form.rootRef} className={'sx-txnform' + (className ? ' ' + className : '')} data-txn-type={form.type} tabIndex={-1}>
      <div ref={barRef} className="sx-txnbar" role="toolbar" aria-label="Transaction">
        <div className="sx-txnbar-nav" role="group" aria-label="Browse">
          <ToolbarButton label="Previous" icon={ChevronLeft} iconOnly disabled={busy} onClick={() => void form.goPrev()} title="Previous transaction" />
          <ToolbarButton label="Next" icon={ChevronRight} iconOnly disabled={busy} onClick={() => void form.goNext()} title="Next transaction" />
        </div>
        <ToolSeparator />
        <ToolbarButton label="New" icon={FilePlus2} className="sx-tb-collapsible" disabled={busy} onClick={() => void form.newTxn()} title="New transaction" />
        <ToolbarButton label="Save" icon={Save} className="sx-tb-collapsible" disabled={busy || readOnly} onClick={() => void form.save('stay')} shortcut="Ctrl+S" />
        {onPrint && <ToolbarButton label="Print" icon={Printer} className="sx-tb-collapsible sx-tb-low" disabled={busy} onClick={onPrint} shortcut="Ctrl+P" />}
        {deleteItems.length === 2 ? (
          <ToolbarButton label="Delete" icon={Trash2} className="sx-tb-collapsible sx-tb-mid" disabled={busy} menu={deleteItems} title="Delete or void" />
        ) : deleteItems.length === 1 ? (
          <ToolbarButton
            label={canDelete ? 'Delete' : 'Void'}
            icon={Trash2}
            className="sx-tb-collapsible sx-tb-mid"
            disabled={busy || deleteItems[0].disabled}
            onClick={deleteItems[0].onClick}
            shortcut={canDelete ? 'Ctrl+D' : undefined}
          />
        ) : null}
        <ToolbarButton label="Make a copy" icon={Copy} className="sx-tb-collapsible sx-tb-low" disabled={busy} onClick={() => void form.copy()} title="Make a copy as a new transaction" />
        <ToolbarButton label="Memorize" icon={BookmarkPlus} className="sx-tb-collapsible sx-tb-low" disabled={busy} onClick={() => form.memorize()} shortcut="Ctrl+M" />
        {showPending && (
          <ToolbarButton
            label={t.isPending ? 'Pending' : 'Mark as pending'}
            icon={Hourglass}
            className="sx-tb-collapsible sx-tb-mid"
            disabled={busy || readOnly}
            pressed={t.isPending}
            onClick={() => form.update({ isPending: !t.isPending })}
            title={t.isPending ? 'Pending: not posted yet. Click to mark it final.' : 'Mark as pending (it will not affect your books until final)'}
          />
        )}
        <ToolbarButton label="More" icon={MoreHorizontal} className="sx-tb-collapsible sx-tb-low" menu={more} title="More actions" />
        {extraButtons && extraButtons.some((b) => !b.hidden) && (
          <>
            <ToolSeparator />
            {extraButtons
              .filter((b) => !b.hidden)
              .map((b, i) => (
                <ToolbarButton
                  key={b.key ?? i}
                  label={b.label}
                  icon={b.icon}
                  color={b.color}
                  onClick={b.onClick}
                  disabled={b.disabled || busy}
                  menu={b.menu}
                  pressed={b.pressed}
                  title={b.title}
                  shortcut={b.shortcut}
                  variant={b.primary ? 'primary' : 'default'}
                  className="sx-tb-extra"
                />
              ))}
          </>
        )}
        <ToolbarSpacer />
      </div>
      <div className="sx-txnform-main">
        <FormErrorsProvider errors={form.fieldErrors} onClear={(f) => form.setFieldError(f, null)}>
          <div className="sx-txnform-col">
            <div ref={bodyRef} className="sx-txnform-body">
              <div className="sx-txnform-titlerow">
                <h1 className="sx-txnform-title">{title}</h1>
                {status ? <StatusPill status={status} className="sx-txnform-status" /> : t.voided ? <StatusPill status="Void" className="sx-txnform-status" /> : null}
                {form.dirty && !busy && <span className="sx-txnbar-note sx-txnform-unsaved">Unsaved changes</span>}
                {titleRight && <div className="sx-txnform-titleright">{titleRight}</div>}
              </div>
              {stamp && <Stamp kind={stamp} />}
              {errCount > 0 && (
                <ErrorBanner
                  className="sx-txnform-banner"
                  errors={form.fieldErrors}
                  message={form.formError}
                  root={form.rootRef.current}
                  title={`Please fix ${errCount === 1 ? 'this problem' : `these ${errCount} problems`} before saving`}
                  onDismiss={() => form.clearErrors()}
                />
              )}
              {header && <div className="sx-txnform-header">{header}</div>}
              {lines && (
                <div className={'sx-txnform-lines' + (linesBad ? ' sx-invalid' : '')} data-field="lines">
                  {lines}
                </div>
              )}
              {footer && <div className="sx-txnform-footer">{footer}</div>}
              {children}
            </div>
            <div className="sx-txnform-sticky">
              <div className="sx-txnform-bl">
                {isNew ? (
                  <Button variant="ghost" label="Clea&r" disabled={busy} onClick={() => void form.clear()} title="Clear the form (Alt+R)" />
                ) : (
                  <Button variant="ghost" label="&Revert" disabled={busy || !form.dirty} onClick={() => form.revert()} title="Undo your changes (Alt+R)" />
                )}
                {bottomLeft}
              </div>
              <div className="sx-txnform-totals">
                {totals !== undefined && totals !== null && (isNodeTotals(totals) ? totals : <FooterTotals totals={totals as FooterTotal[]} />)}
              </div>
              <div className="sx-txnform-savebtns">
                {!hideSaveNew && <Button variant="secondary" label="Save and &new" disabled={busy || readOnly} onClick={() => void form.save('new')} />}
                <Button variant="primary" label="&Save and close" disabled={busy || readOnly} busy={form.saving} onClick={() => void form.save('close')} />
              </div>
            </div>
            {form.loading && (
              <div className="sx-txnform-loading">
                <Spinner label="Loading..." />
              </div>
            )}
          </div>
        </FormErrorsProvider>
        {sidePanel}
      </div>
    </div>
  );
}

/** Props of {@link FooterTotals}. */
export interface FooterTotalsProps {
  totals: FooterTotal[];
  className?: string;
}

/** Horizontal totals of the sticky footer (TxnFormFrame renders it from `totals`). */
export function FooterTotals({ totals, className }: FooterTotalsProps) {
  return (
    <dl className={'sx-ftotals' + (className ? ' ' + className : '')}>
      {totals.map((x, i) => (
        <div key={x.key ?? i} className={'sx-ftotal' + (x.strong ? ' sx-strong' : '') + (x.tone ? ` sx-tone-text-${x.tone}` : '')}>
          <dt>{x.label}</dt>
          <dd>{typeof x.value === 'number' ? fmtMoney(x.value) : x.value}</dd>
        </div>
      ))}
    </dl>
  );
}
