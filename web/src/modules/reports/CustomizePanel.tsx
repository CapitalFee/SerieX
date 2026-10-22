// "Customize" side panel of the report window (instead of a tabbed Modify Report dialog):
// filters, columns, header/footer and number format. Every change applies at once.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReportColumn, ReportInfo, TxnType } from '@/api/types';
import { BALANCE_SHEET_TYPES, PROFIT_LOSS_TYPES, TXN_TYPE_LABELS } from '@/api/types';
import { useAccounts, useItems, useList, useNames, usePrefValues } from '@/api/hooks';
import { Button, Checkbox, MoneyField, RadioGroup, SearchBox, SegmentedControl, Select, SidePanel, Tabs, TextField } from '@/components';
import { DETAIL_COLS_DEFAULT, DETAIL_COLUMNS, filterIsSet, offersNoClass, offersPlOnly, supportedFilters, type FilterKind } from './reportMeta';
import type { DisplayOptions, HeaderPart, NegStyle } from './reportFormat';

/** Report params patch: a key set to undefined is removed. */
export type ParamPatch = Record<string, string | undefined>;

/** Width of the Customize panel in px (the report window makes room for it when it can). */
export const CUSTOMIZE_PANEL_WIDTH = 360;

/** Props of {@link CustomizePanel}. */
export interface CustomizePanelProps {
  open: boolean;
  onClose: () => void;
  info: ReportInfo;
  rp: Record<string, string>;
  setRp: (patch: ParamPatch) => void;
  display: DisplayOptions;
  setDisplay: (patch: Partial<DisplayOptions>) => void;
  /** Columns of the current result (for hiding columns). */
  resultCols: ReportColumn[];
  /** Placeholders for the title/subtitle fields. */
  defaultTitle: string;
  defaultSubtitle: string;
  onReset: () => void;
  tab: string;
  onTabChange: (tab: string) => void;
}

/** Number of filters set in the params (badge on the Customize button). */
export function filterCount(rp: Record<string, string>): number {
  let n = 0;
  for (const k of ['accountIds', 'nameIds', 'itemIds', 'classIds', 'types', 'cleared', 'memo', 'refNumber', 'plOnly', 'noClass']) if (rp[k]) n++;
  if (rp.amountMin || rp.amountMax) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Checklist

interface CheckItem {
  id: string;
  label: string;
  level?: number;
  note?: string;
}

const MAX_SHOWN = 400;

/** Searchable list of check boxes (filters on several accounts, names, items...). */
function Checklist({ items, value, onChange, what }: { items: CheckItem[]; value: string[]; onChange: (ids: string[]) => void; what: string }) {
  const [q, setQ] = useState('');
  const sel = useMemo(() => new Set(value), [value]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? items.filter((i) => i.label.toLowerCase().includes(t) || i.note?.toLowerCase().includes(t)) : items;
  }, [items, q]);
  const toggle = (id: string, on: boolean) => {
    const n = new Set(sel);
    if (on) n.add(id);
    else n.delete(id);
    onChange(items.map((i) => i.id).filter((x) => n.has(x)));
  };
  return (
    <div className="rpt-check">
      <SearchBox value={q} onChange={setQ} placeholder={`Find ${what}`} />
      <div className="rpt-check-list" role="group" aria-label={what}>
        {shown.slice(0, MAX_SHOWN).map((i) => (
          <label key={i.id} className="rpt-check-row" style={{ paddingLeft: 6 + (q ? 0 : (i.level ?? 0) * 14) }}>
            <input type="checkbox" checked={sel.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} />
            <span className="rpt-check-label">{i.label}</span>
            {i.note && <span className="rpt-check-note">{i.note}</span>}
          </label>
        ))}
        {shown.length === 0 && <div className="rpt-check-empty">Nothing matches "{q}".</div>}
        {shown.length > MAX_SHOWN && <div className="rpt-check-empty">Type to find more ({shown.length - MAX_SHOWN} not shown).</div>}
      </div>
      <div className="rpt-check-foot">
        <span>{value.length ? `${value.length} selected` : 'None selected'}</span>
        <button type="button" className="sx-linkbtn" onClick={() => onChange(Array.from(new Set([...value, ...shown.map((i) => i.id)])))}>
          Select all{q ? ' shown' : ''}
        </button>
        <button type="button" className="sx-linkbtn" onClick={() => onChange([])} disabled={!value.length}>
          Clear
        </button>
      </div>
    </div>
  );
}

const ids = (s: string | undefined) => (s ? s.split(',').filter(Boolean) : []);
const joinIds = (a: string[]) => (a.length ? a.join(',') : undefined);

/** A text filter that applies after a short pause in typing. */
function DebouncedText({ value, onChange, placeholder, name }: { value: string; onChange: (v: string) => void; placeholder?: string; name: string }) {
  const [t, setT] = useState(value);
  const timer = useRef<number>();
  useEffect(() => setT(value), [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <TextField
      name={name}
      value={t}
      placeholder={placeholder}
      onChange={(v) => {
        setT(v);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => onChange(v.trim()), 500);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          window.clearTimeout(timer.current);
          onChange(t.trim());
        }
      }}
    />
  );
}

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="rpt-cz-sec">
      <div className="rpt-cz-title">{title}</div>
      {hint && <div className="rpt-cz-hint">{hint}</div>}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filters tab

function FiltersTab({ info, rp, setRp }: Pick<CustomizePanelProps, 'info' | 'rp' | 'setRp'>) {
  const prefs = usePrefValues();
  const offered = new Set(supportedFilters(info));
  // a filter is also shown while set where the report does not offer it (a drill-down from a
  // filtered Balance Sheet to the Profit and Loss carries the cleared status, an older memorized
  // report), so it can be seen and turned off
  const has = { has: (k: FilterKind) => offered.has(k) || filterIsSet(k, rp) };
  // "Income and expense accounts only" and "No class only" are offered where they change the
  // report (and shown while set, e.g. by an older memorized report, so they can be turned off)
  const plChoice = offersPlOnly(info) || rp.plOnly === '1';
  const noClassChoice = offersNoClass(info) || rp.noClass === '1';
  const clearedChoice = has.has('cleared');
  const { data: accounts } = useAccounts({ active: 'all' });
  const { data: names } = useNames(undefined, { active: 'all' });
  const { data: items } = useItems({ active: 'all' });
  const { data: classes } = useList('class', { active: 'all' });

  const acctMode = rp.plOnly === '1' ? 'pl' : rp.accountIds ? 'selected' : 'all';
  const [acctPick, setAcctPick] = useState(acctMode === 'selected');
  const nameMode = rp.nameIds ? 'selected' : 'all';
  const [namePick, setNamePick] = useState(nameMode === 'selected');
  const [itemPick, setItemPick] = useState(!!rp.itemIds);
  const classMode = rp.noClass === '1' ? 'none' : rp.classIds ? 'selected' : 'all';
  const [classPick, setClassPick] = useState(classMode === 'selected');
  const [typePick, setTypePick] = useState(!!rp.types);
  const [amtRange, setAmtRange] = useState(!!(rp.amountMin || rp.amountMax));

  const acctItems = useMemo<CheckItem[]>(
    () =>
      (accounts ?? []).map((a) => ({
        id: String(a.id),
        label: a.name,
        level: a.level,
        note: a.type + (a.active ? '' : ' (inactive)'),
      })),
    [accounts],
  );
  const nameItems = useMemo<CheckItem[]>(() => {
    const kindLabel = {
      customer: 'Customer',
      vendor: 'Vendor',
      other: 'Other',
    } as const;
    const order = { customer: 0, vendor: 1, other: 2 } as const;
    return [...(names ?? [])]
      .sort(
        (a, b) =>
          order[a.kind] - order[b.kind] ||
          a.fullName.localeCompare(b.fullName, undefined, {
            sensitivity: 'base',
          }),
      )
      .map((n) => ({
        id: String(n.id),
        label: n.parentId ? n.name : n.name,
        level: n.level,
        note: n.parentId ? 'Job' : kindLabel[n.kind],
      }));
  }, [names]);
  const itemItems = useMemo<CheckItem[]>(
    () =>
      (items ?? []).map((i) => ({
        id: String(i.id),
        label: i.name,
        level: i.level,
        note: i.type,
      })),
    [items],
  );
  const classItems = useMemo<CheckItem[]>(
    () =>
      (classes ?? []).map((c) => ({
        id: String(c.id),
        label: c.name,
        level: c.level,
      })),
    [classes],
  );
  const typeItems = useMemo<CheckItem[]>(
    () =>
      (Object.keys(TXN_TYPE_LABELS) as TxnType[]).map((t) => ({
        id: t,
        label: TXN_TYPE_LABELS[t],
      })),
    [],
  );

  const quickAccounts = (types: readonly string[]) =>
    setRp({
      accountIds: joinIds((accounts ?? []).filter((a) => types.includes(a.type)).map((a) => String(a.id))),
      plOnly: undefined,
    });

  return (
    <div className="rpt-cz">
      {has.has('accounts') && (
        <Section title="Accounts">
          <Select
            value={acctPick ? 'selected' : acctMode}
            aria-label="Accounts"
            onChange={(v) => {
              setAcctPick(v === 'selected');
              if (v === 'all') setRp({ accountIds: undefined, plOnly: undefined });
              else if (v === 'pl') setRp({ accountIds: undefined, plOnly: '1' });
              else setRp({ plOnly: undefined });
            }}
            options={[
              { value: 'all', label: 'All accounts' },
              ...(plChoice ? [{ value: 'pl', label: 'Income and expense accounts only' }] : []),
              { value: 'selected', label: 'Selected accounts…' },
            ]}
          />
          {acctPick && (
            <>
              <div className="rpt-cz-quick">
                Quick pick:
                <button type="button" className="sx-linkbtn" onClick={() => quickAccounts(BALANCE_SHEET_TYPES)}>
                  Balance sheet accounts
                </button>
                <button type="button" className="sx-linkbtn" onClick={() => quickAccounts(PROFIT_LOSS_TYPES)}>
                  Income and expense accounts
                </button>
              </div>
              <Checklist items={acctItems} value={ids(rp.accountIds)} onChange={(v) => setRp({ accountIds: joinIds(v) })} what="accounts" />
            </>
          )}
        </Section>
      )}

      {has.has('names') && (
        <Section title="Customers, vendors and other names">
          <Select
            value={namePick ? 'selected' : nameMode}
            aria-label="Names"
            onChange={(v) => {
              setNamePick(v === 'selected');
              if (v === 'all') setRp({ nameIds: undefined });
            }}
            options={[
              { value: 'all', label: 'All names' },
              { value: 'selected', label: 'Selected names…' },
            ]}
          />
          {namePick && (
            <Checklist
              items={nameItems}
              value={ids(rp.nameIds)}
              onChange={(v) =>
                setRp({
                  nameIds: joinIds(v),
                  includeJobs: v.length ? '1' : undefined,
                })
              }
              what="names"
            />
          )}
        </Section>
      )}

      {has.has('items') && (
        <Section title="Items">
          <Select
            value={itemPick ? 'selected' : 'all'}
            aria-label="Items"
            onChange={(v) => {
              setItemPick(v === 'selected');
              if (v === 'all') setRp({ itemIds: undefined });
            }}
            options={[
              { value: 'all', label: 'All items' },
              { value: 'selected', label: 'Selected items…' },
            ]}
          />
          {itemPick && <Checklist items={itemItems} value={ids(rp.itemIds)} onChange={(v) => setRp({ itemIds: joinIds(v) })} what="items" />}
        </Section>
      )}

      {(prefs.useClassTracking || filterIsSet('classes', rp)) && has.has('classes') && (
        <Section title="Classes">
          <Select
            value={classPick ? 'selected' : classMode}
            aria-label="Classes"
            onChange={(v) => {
              setClassPick(v === 'selected');
              if (v === 'all') setRp({ classIds: undefined, noClass: undefined });
              else if (v === 'none') setRp({ classIds: undefined, noClass: '1' });
              else setRp({ noClass: undefined });
            }}
            options={[{ value: 'all', label: 'All classes' }, ...(noClassChoice ? [{ value: 'none', label: 'No class only' }] : []), { value: 'selected', label: 'Selected classes…' }]}
          />
          {classPick && <Checklist items={classItems} value={ids(rp.classIds)} onChange={(v) => setRp({ classIds: joinIds(v) })} what="classes" />}
        </Section>
      )}

      {has.has('types') && (
        <Section title="Transaction types">
          <Select
            value={typePick ? 'selected' : 'all'}
            aria-label="Transaction types"
            onChange={(v) => {
              setTypePick(v === 'selected');
              if (v === 'all') setRp({ types: undefined });
            }}
            options={[
              { value: 'all', label: 'All transaction types' },
              { value: 'selected', label: 'Selected types…' },
            ]}
          />
          {typePick && <Checklist items={typeItems} value={ids(rp.types)} onChange={(v) => setRp({ types: joinIds(v) })} what="transaction types" />}
        </Section>
      )}

      {clearedChoice && (
        <Section title="Cleared status" hint="Whether the bank or credit card entry was checked off when you reconciled the account.">
          <SegmentedControl
            size="sm"
            value={rp.cleared === 'cleared' || rp.cleared === 'uncleared' ? rp.cleared : 'all'}
            onChange={(v) => setRp({ cleared: v === 'all' ? undefined : v })}
            aria-label="Cleared status"
            options={[
              { value: 'all', label: 'Either' },
              { value: 'cleared', label: 'Cleared' },
              { value: 'uncleared', label: 'Not cleared' },
            ]}
          />
        </Section>
      )}

      {has.has('amount') && (
        <Section title="Amount" hint="Transaction amount, ignoring the sign.">
          <Select
            value={amtRange ? 'range' : 'any'}
            aria-label="Amount"
            onChange={(v) => {
              setAmtRange(v === 'range');
              if (v === 'any') setRp({ amountMin: undefined, amountMax: undefined });
            }}
            options={[
              { value: 'any', label: 'Any amount' },
              { value: 'range', label: 'Between…' },
            ]}
          />
          {amtRange && (
            <div className="rpt-cz-range">
              <MoneyField
                name="amountMin"
                nullable
                value={rp.amountMin ? Number(rp.amountMin) : null}
                onChange={(v) => setRp({ amountMin: v === null ? undefined : String(v) })}
                aria-label="Minimum amount"
                placeholder="From"
              />
              <span>and</span>
              <MoneyField
                name="amountMax"
                nullable
                value={rp.amountMax ? Number(rp.amountMax) : null}
                onChange={(v) => setRp({ amountMax: v === null ? undefined : String(v) })}
                aria-label="Maximum amount"
                placeholder="To"
              />
            </div>
          )}
        </Section>
      )}

      {has.has('memo') && (
        <Section title="Memo contains">
          <DebouncedText name="memo" value={rp.memo ?? ''} onChange={(v) => setRp({ memo: v || undefined })} placeholder="Any memo" />
        </Section>
      )}
      {has.has('refNumber') && (
        <Section title="Number contains" hint="Invoice, check or other reference number.">
          <DebouncedText name="refNumber" value={rp.refNumber ?? ''} onChange={(v) => setRp({ refNumber: v || undefined })} placeholder="Any number" />
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns tab

function ColumnsTab({ info, rp, setRp, display, setDisplay, resultCols }: Pick<CustomizePanelProps, 'info' | 'rp' | 'setRp' | 'display' | 'setDisplay' | 'resultCols'>) {
  const defaults = DETAIL_COLS_DEFAULT[info.key];
  if (defaults) {
    const cur = rp.cols ? rp.cols.split(',') : defaults;
    const set = new Set(cur);
    const toggle = (k: string, onv: boolean) => {
      const n = new Set(set);
      if (onv) n.add(k);
      else n.delete(k);
      if (!n.size) return;
      const ordered = DETAIL_COLUMNS.map((c) => c.value).filter((x) => n.has(x));
      const same = ordered.length === defaults.length && ordered.every((x, i) => x === defaults[i]);
      setRp({ cols: same ? undefined : ordered.join(',') });
    };
    return (
      <div className="rpt-cz">
        <Section title="Columns to show" hint="Pick the details shown for each transaction.">
          <div className="rpt-cz-cols">
            {DETAIL_COLUMNS.filter((c) => c.value !== 'trans').map((c) => (
              <Checkbox key={c.value} checked={set.has(c.value)} onChange={(v) => toggle(c.value, v)} label={c.label} disabled={set.has(c.value) && set.size === 1} />
            ))}
          </div>
          <button type="button" className="sx-linkbtn" onClick={() => setRp({ cols: undefined })} disabled={!rp.cols}>
            Back to the standard columns
          </button>
        </Section>
      </div>
    );
  }
  const cols = resultCols.filter((c) => c.key !== 'label');
  const hidden = new Set(display.hidden);
  return (
    <div className="rpt-cz">
      <Section title="Columns to show" hint={cols.length ? 'Clear a box to hide that column.' : undefined}>
        {cols.length === 0 && <div className="rpt-cz-hint">This report has no columns to hide.</div>}
        <div className="rpt-cz-cols">
          {cols.map((c) => (
            <Checkbox
              key={c.key}
              checked={!hidden.has(c.key)}
              label={c.label || c.key}
              disabled={!hidden.has(c.key) && cols.filter((x) => !hidden.has(x.key)).length === 1}
              onChange={(v) => {
                const n = new Set(hidden);
                if (v) n.delete(c.key);
                else n.add(c.key);
                setDisplay({ hidden: [...n] });
              }}
            />
          ))}
        </div>
        {display.hidden.length > 0 && (
          <button type="button" className="sx-linkbtn" onClick={() => setDisplay({ hidden: [] })}>
            Show every column
          </button>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header / numbers tabs

const HEADER_PARTS: { key: HeaderPart; label: string }[] = [
  { key: 'company', label: 'Company name' },
  { key: 'title', label: 'Report title' },
  { key: 'subtitle', label: 'Subtitle (dates)' },
  { key: 'date', label: 'Date prepared' },
  { key: 'time', label: 'Time prepared' },
  { key: 'basis', label: 'Report basis (accrual or cash)' },
];

function HeaderTab({ display, setDisplay, defaultTitle, defaultSubtitle }: Pick<CustomizePanelProps, 'display' | 'setDisplay' | 'defaultTitle' | 'defaultSubtitle'>) {
  const off = new Set(display.hdrOff);
  const toggle = (k: HeaderPart, v: boolean) => {
    const n = new Set(off);
    if (v) n.delete(k);
    else n.add(k);
    setDisplay({ hdrOff: [...n] });
  };
  return (
    <div className="rpt-cz">
      <Section title="Show in the header">
        <div className="rpt-cz-cols rpt-cz-one">
          {HEADER_PARTS.map((p) => (
            <Checkbox key={p.key} checked={!off.has(p.key)} onChange={(v) => toggle(p.key, v)} label={p.label} />
          ))}
        </div>
      </Section>
      <Section title="Report title">
        <TextField name="ui.title" value={display.title} onChange={(v) => setDisplay({ title: v })} placeholder={defaultTitle} />
      </Section>
      <Section title="Subtitle">
        <TextField name="ui.subtitle" value={display.subtitle} onChange={(v) => setDisplay({ subtitle: v })} placeholder={defaultSubtitle || 'Dates of the report'} />
      </Section>
      <Section title="Footer line" hint="Printed under the report (for example a note to your accountant).">
        <TextField name="ui.footer" value={display.footer} onChange={(v) => setDisplay({ footer: v })} placeholder="No footer" />
      </Section>
    </div>
  );
}

function NumbersTab({ display, setDisplay }: Pick<CustomizePanelProps, 'display' | 'setDisplay'>) {
  return (
    <div className="rpt-cz">
      <Section title="Negative numbers">
        <RadioGroup<NegStyle>
          value={display.neg}
          onChange={(v) => setDisplay({ neg: v })}
          aria-label="Negative numbers"
          options={[
            { value: 'minus', label: '-300.00' },
            { value: 'parens', label: '(300.00)' },
            { value: 'trailing', label: '300.00-' },
          ]}
        />
        <Checkbox checked={display.red} onChange={(v) => setDisplay({ red: v })} label="Show negative numbers in red" />
      </Section>
      <Section title="Show all numbers">
        <div className="rpt-cz-cols rpt-cz-one">
          <Checkbox checked={display.thousands} onChange={(v) => setDisplay({ thousands: v })} label="Divided by 1000" />
          <Checkbox checked={display.noCents} onChange={(v) => setDisplay({ noCents: v })} label="Without cents" />
          <Checkbox checked={display.blankZero} onChange={(v) => setDisplay({ blankZero: v })} label="Leave zero amounts blank" />
          <Checkbox checked={display.hideZeroRows} onChange={(v) => setDisplay({ hideZeroRows: v })} label="Hide rows where every amount is zero" />
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** The Customize side panel. */
export function CustomizePanel(props: CustomizePanelProps) {
  const { open, onClose, info, rp, tab, onTabChange, onReset } = props;
  // the Filters tab is also there while a filter the report does not offer is set (so it can be turned off)
  const withFilters = supportedFilters(info).length > 0 || filterCount(rp) > 0;
  const tabs = [
    ...(withFilters ? [{ key: 'filters', label: 'Filters' }] : []),
    { key: 'columns', label: 'Columns' },
    { key: 'header', label: 'Header' },
    { key: 'numbers', label: 'Numbers' },
  ];
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0].key;
  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title="Customize report"
      width={CUSTOMIZE_PANEL_WIDTH}
      backdrop={false}
      footer={
        <div className="rpt-cz-foot">
          <button type="button" className="sx-linkbtn" onClick={onReset}>
            Reset to the standard report
          </button>
          <Button variant="primary" label="Done" onClick={onClose} />
        </div>
      }
    >
      <Tabs variant="strip" tabs={tabs} active={active} onChange={onTabChange} aria-label="Customize sections">
        {active === 'filters' && <FiltersTab {...props} />}
        {active === 'columns' && <ColumnsTab {...props} />}
        {active === 'header' && <HeaderTab {...props} />}
        {active === 'numbers' && <NumbersTab {...props} />}
      </Tabs>
    </SidePanel>
  );
}
