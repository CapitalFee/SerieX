// Record form chrome with the SerieX Books transaction form look (Paycheck, Tax Payment,
// Tax Balance Adjustment):
//
//   ◄ ► │ New  Save  Print  Delete ▾  More ▾ │ form actions …                    Unsaved changes
//   ─────────────────────────────────────────────────────────────────────────────────────────────
//   Paycheck  [Void]                                                      titleRight
//   [error banner: problems of the last save, click to jump to the field]
//   header slot (bank account, check face…)
//   lines slot (grid; takes the remaining height)
//   footer slot (memo, posting status…)
//   ─────────────────────────────────────────────────────────────────────────────────────────────
//   sticky: Clear│Revert  bottomLeft        totals …        Save and new   [Save and close]
//
// Unlike the SerieX Books framework (useTxnForm) this frame keeps no form state: the module passes
// its state (isNew, dirty, busy, field errors…) and handlers. Buttons without a handler are not
// shown (no controls that do nothing). Alt+S / Alt+N / Alt+R come from the button labels.
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { ChevronLeft, ChevronRight, FilePlus2, MoreHorizontal, Printer, Save, Search, Trash2, type LucideIcon } from 'lucide-react';
import { Button, ToolbarButton, ToolSeparator, ToolbarSpacer } from '@/components/buttons';
import type { MenuItem } from '@/components/menu';
import { Spinner } from '@/components/layout';
import { ErrorBanner, FormErrorsProvider, type FieldErrors } from '@/components/formErrors';
import { StatusPill } from '@/components/display';
import { useHotkeys } from '@/components/hotkeys';
import { fmtMoney } from '@/util/format';
import { Stamp, type StampKind } from './parts';

/** A toolbar button (form-specific buttons are passed by the module, e.g. "Paycheck detail"). */
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

/** One total of the sticky footer ("Net pay 1,082.50"). */
export interface FooterTotal {
  key?: string;
  label: ReactNode;
  /** Amount (formatted 1,234.56) or any node. */
  value: number | ReactNode;
  /** Bigger, bold (the important number: Net pay / Total). */
  strong?: boolean;
  /** Color of the value. */
  tone?: 'danger' | 'success' | 'muted';
}

/** Props of {@link FormFrame}. */
export interface FormFrameProps {
  /** Big title at the top-left of the form ("Paycheck", "Tax Payment"). */
  title: string;
  /** Status pill next to the title ("Posted", "Void", "To print"...). */
  status?: string | null;
  /** Content right of the title. */
  titleRight?: ReactNode;
  /** Header fields (bank account, check face...). */
  header?: ReactNode;
  /** Lines area (grid); it takes the remaining height. */
  lines?: ReactNode;
  /** Footer inside the scrolling body (memo, posting status...). */
  footer?: ReactNode;
  /** Extra content after the footer. */
  children?: ReactNode;
  /** Totals always visible in the sticky bottom bar (array of totals, or any node). */
  totals?: FooterTotal[] | ReactNode;
  /** Right side panel (HistoryPanelFrame). */
  sidePanel?: ReactNode;
  stamp?: StampKind | null;

  /** The record is not saved yet (shows Clear instead of Revert). */
  isNew?: boolean;
  /** Unsaved changes (enables Revert, shows "Unsaved changes"). */
  dirty?: boolean;
  /** Saving or loading: disables the buttons. */
  busy?: boolean;
  /** Saving: spinner on Save and close. */
  saving?: boolean;
  /** Shows the loading overlay. */
  loading?: boolean;
  /** Read-only form (e.g. a voided record): disables saving buttons. */
  readOnly?: boolean;
  /** Inline field errors (by control name) and a general message, shown in the error banner. */
  fieldErrors?: FieldErrors;
  formError?: string | null;
  /** Called when the user edits a field that has an error. */
  onClearError?: (field: string) => void;
  /** Dismisses the error banner. */
  onClearErrors?: () => void;

  /** Previous / next record (the arrows are shown when either is given). */
  onPrev?: () => void;
  onNext?: () => void;
  /** Find (in "More ▾", Ctrl+F handled by the shell). */
  onFind?: () => void;
  /** New record. */
  onNew?: () => void;
  /** Save and stay (Ctrl+S). */
  onSave?: () => void;
  /** Save and close (Alt+S). */
  onSaveClose?: () => void;
  /** Save and new (Alt+N); hidden without handler or with hideSaveNew. */
  onSaveNew?: () => void;
  /** Revert to the saved record (Alt+R). */
  onRevert?: () => void;
  /** Clear a new record (Alt+R). */
  onClear?: () => void;
  /** Void (Delete ▾ menu). */
  onVoid?: () => void;
  /** Delete (Delete ▾ menu, Ctrl+D). */
  onDelete?: () => void;
  /** Print (Ctrl+P). */
  onPrint?: () => void;

  /** Form-specific toolbar buttons (after the standard ones). */
  extraButtons?: RibbonButton[];
  /** Entries of the "More ▾" menu (reports about this record). */
  reportButtons?: RibbonButton[];
  /** Content at the left of the sticky bottom bar (e.g. "To be printed"). */
  bottomLeft?: ReactNode;
  hideSaveNew?: boolean;
  className?: string;
  /** Root element (e.g. for commitActiveEditor before saving). */
  rootRef?: RefObject<HTMLDivElement>;
}

function isNodeTotals(t: FormFrameProps['totals']): t is ReactNode {
  return !Array.isArray(t);
}

/** The standard record form window content. */
export function FormFrame(props: FormFrameProps) {
  const { title, status, titleRight, header, lines, footer, children, totals, sidePanel, stamp, isNew, dirty, busy, saving, loading, readOnly, extraButtons, reportButtons, bottomLeft, hideSaveNew, className } =
    props;
  const ownRef = useRef<HTMLDivElement>(null);
  const rootRef = props.rootRef ?? ownRef;
  const fieldErrors = props.fieldErrors ?? {};
  const errCount = Object.keys(fieldErrors).length + (props.formError ? 1 : 0);

  useHotkeys(
    {
      'ctrl+s': () => {
        if (!props.onSave || busy || readOnly) return false;
        props.onSave();
      },
      'ctrl+d': () => {
        if (!props.onDelete || busy || readOnly) return false;
        props.onDelete();
      },
      'ctrl+p': () => {
        if (!props.onPrint || busy) return false;
        props.onPrint();
      },
    },
    [props.onSave, props.onDelete, props.onPrint, busy, readOnly],
  );

  const deleteItems: MenuItem[] = [
    ...(props.onVoid ? [{ label: '&Void', disabled: isNew || readOnly, onClick: () => props.onVoid?.() }] : []),
    ...(props.onDelete ? [{ label: '&Delete', shortcut: 'Ctrl+D', disabled: !!readOnly, onClick: () => props.onDelete?.() }] : []),
  ];
  const more: MenuItem[] = [
    ...(reportButtons ?? [])
      .filter((b) => !b.hidden)
      .map<MenuItem>((b) => ({ label: b.label, disabled: b.disabled, onClick: b.onClick, items: b.menu, shortcut: b.shortcut })),
    ...(props.onFind ? [...(reportButtons?.length ? [{ separator: true } as MenuItem] : []), { label: '&Find…', onClick: props.onFind }] : []),
  ];

  // Toolbar labels collapse to icons only when the buttons do not fit (same as SerieX Books).
  const barRef = useRef<HTMLDivElement>(null);
  const barKey = [
    !!props.onPrint,
    !!dirty && !busy,
    deleteItems.length,
    more.length,
    (extraButtons ?? []).filter((b) => !b.hidden).map((b) => b.label + (b.menu ? '▾' : '')).join(','),
  ].join('|');
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const fits = () => bar.scrollWidth <= bar.clientWidth + 1;
    const fit = () => {
      bar.classList.remove('sx-tb-c1', 'sx-tb-c2');
      if (fits()) return;
      bar.classList.add('sx-tb-c1');
      if (fits()) return;
      bar.classList.add('sx-tb-c2');
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [barKey]);

  const hasNav = !!(props.onPrev || props.onNext);
  const extras = (extraButtons ?? []).filter((b) => !b.hidden);

  return (
    <div ref={rootRef} className={'sx-txnform' + (className ? ' ' + className : '')} tabIndex={-1}>
      <div ref={barRef} className="sx-txnbar" role="toolbar" aria-label="Record">
        {hasNav && (
          <>
            <div className="sx-txnbar-nav" role="group" aria-label="Browse">
              <ToolbarButton label="Previous" icon={ChevronLeft} iconOnly disabled={busy || !props.onPrev} onClick={() => props.onPrev?.()} title="Previous" />
              <ToolbarButton label="Next" icon={ChevronRight} iconOnly disabled={busy || !props.onNext} onClick={() => props.onNext?.()} title="Next" />
            </div>
            <ToolSeparator />
          </>
        )}
        {props.onNew && <ToolbarButton label="New" icon={FilePlus2} className="sx-tb-collapsible" disabled={busy} onClick={props.onNew} title="New" />}
        {props.onSave && <ToolbarButton label="Save" icon={Save} className="sx-tb-collapsible" disabled={busy || readOnly} onClick={props.onSave} shortcut="Ctrl+S" />}
        {props.onPrint && <ToolbarButton label="Print" icon={Printer} className="sx-tb-collapsible" disabled={busy} onClick={props.onPrint} shortcut="Ctrl+P" />}
        {deleteItems.length === 2 ? (
          <ToolbarButton label="Delete" icon={Trash2} className="sx-tb-collapsible" disabled={busy} menu={deleteItems} title="Delete or void" />
        ) : deleteItems.length === 1 ? (
          <ToolbarButton
            label={props.onDelete ? 'Delete' : 'Void'}
            icon={Trash2}
            className="sx-tb-collapsible"
            disabled={busy || deleteItems[0].disabled}
            onClick={deleteItems[0].onClick}
            shortcut={props.onDelete ? 'Ctrl+D' : undefined}
          />
        ) : null}
        {more.length > 0 && <ToolbarButton label="More" icon={props.onFind && !reportButtons?.length ? Search : MoreHorizontal} className="sx-tb-collapsible" menu={more} title="More actions" />}
        {extras.length > 0 && (
          <>
            <ToolSeparator />
            {extras.map((b, i) => (
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
        {dirty && !busy && <span className="sx-txnbar-note">Unsaved changes</span>}
      </div>
      <div className="sx-txnform-main">
        <FormErrorsProvider errors={fieldErrors} onClear={props.onClearError}>
          <div className="sx-txnform-col">
            <div className="sx-txnform-body">
              <div className="sx-txnform-titlerow">
                <h1 className="sx-txnform-title">{title}</h1>
                {status ? <StatusPill status={status} className="sx-txnform-status" /> : null}
                {titleRight && <div className="sx-txnform-titleright">{titleRight}</div>}
              </div>
              {stamp && <Stamp kind={stamp} />}
              {errCount > 0 && (
                <ErrorBanner
                  className="sx-txnform-banner"
                  errors={fieldErrors}
                  message={props.formError}
                  root={rootRef.current}
                  title={`Please fix ${errCount === 1 ? 'this problem' : `these ${errCount} problems`} before saving`}
                  onDismiss={props.onClearErrors}
                />
              )}
              {header && <div className="sx-txnform-header">{header}</div>}
              {lines && (
                <div className={'sx-txnform-lines' + (fieldErrors.lines ? ' sx-invalid' : '')} data-field="lines">
                  {lines}
                </div>
              )}
              {footer && <div className="sx-txnform-footer">{footer}</div>}
              {children}
            </div>
            <div className="sx-txnform-sticky">
              <div className="sx-txnform-bl">
                {isNew
                  ? props.onClear && <Button variant="ghost" label="Clea&r" disabled={busy} onClick={props.onClear} title="Clear the form (Alt+R)" />
                  : props.onRevert && <Button variant="ghost" label="&Revert" disabled={busy || !dirty} onClick={props.onRevert} title="Undo your changes (Alt+R)" />}
                {bottomLeft}
              </div>
              <div className="sx-txnform-totals">
                {totals !== undefined && totals !== null && (isNodeTotals(totals) ? totals : <FooterTotals totals={totals as FooterTotal[]} />)}
              </div>
              <div className="sx-txnform-savebtns">
                {props.onSaveNew && !hideSaveNew && <Button variant="secondary" label="Save and &new" disabled={busy || readOnly} onClick={props.onSaveNew} />}
                {props.onSaveClose && <Button variant="primary" label="&Save and close" disabled={busy || readOnly} busy={saving} onClick={props.onSaveClose} />}
              </div>
            </div>
            {loading && (
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

/** Horizontal totals of the sticky footer (FormFrame renders it from `totals`). */
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

/** One toolbar button outside the frame (modules with their own toolbars). */
export function RibbonBtn({ b }: { b: RibbonButton }) {
  if (b.hidden) return null;
  return (
    <ToolbarButton
      label={b.label}
      icon={b.icon}
      color={b.color}
      onClick={b.onClick}
      disabled={b.disabled}
      menu={b.menu}
      pressed={b.pressed}
      title={b.title}
      shortcut={b.shortcut}
      variant={b.primary ? 'primary' : 'default'}
    />
  );
}
