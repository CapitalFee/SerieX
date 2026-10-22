// Report window: report "paper" with a clean filter bar, a Customize side panel, Memorize,
// Print, Export CSV, collapsible sections and drill-down.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkPlus, ChevronsDownUp, ChevronsUpDown, Download, Heading, Printer, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '@/api/client';
import type { Account, Item, Name, ReportColumn, ReportResult } from '@/api/types';
import { useCompanyInfo, usePrefValues, useReport, useReportsCatalog } from '@/api/hooks';
import { Button, FormErrorsProvider, Spinner, Toolbar, ToolbarButton, ToolbarSpacer, ToolSeparator, toast, useFormErrors, useHotkeys } from '@/components';
import { downloadCsv } from '@/util/csv';
import { printHtml } from '@/util/print';
import { resolvePreset } from '@/util/dates';
import { today } from '@/state/session';
import { useWindow } from '@/windows/WindowContext';
import { CUSTOMIZE_PANEL_WIDTH, CustomizePanel, filterCount, type ParamPatch } from './CustomizePanel';
import { FilterBar } from './FilterBar';
import { PAPER_SIDES, ReportPaper, scrollbarWidth } from './ReportPaper';
import {
  DEFAULT_DISPLAY,
  analyze,
  collapseAllSet,
  displayChangeCount,
  displayToParams,
  fitColumns,
  headerText,
  isEmptyResult,
  isNumericCol,
  measureColumnSizes,
  reportCsvRows,
  reportPrintHtml,
  splitParams,
  visibleRows,
  type DisplayOptions,
} from './reportFormat';
import { REQUIRED_ID, REQUIRED_ID_PROMPT, defaultColumns, hasParam, reportInfo, unusableFilters } from './reportMeta';
import { memorizeReport } from './memorized';
import { recordRecentReport } from './reportStore';
import './reports.css';

/** Window props. The report key is `useWindow().props.key` (React never passes a prop named `key`; the shell also passes it as `reportKey`). */
export interface ReportWindowProps {
  reportKey?: string;
  params?: Record<string, string>;
  memorizedId?: number;
  title?: string;
}

function widthsKey(key: string) {
  return `sx.rpt.w.${key}`;
}

function loadWidths(key: string): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(widthsKey(key)) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function saveWidths(key: string, w: Record<string, number>) {
  try {
    localStorage.setItem(widthsKey(key), JSON.stringify(w));
  } catch {
    /* ignore */
  }
}

/** Removes undefined values and applies a patch. */
function applyPatch(rp: Record<string, string>, patch: ParamPatch): Record<string, string> {
  const n = { ...rp };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete n[k];
    else n[k] = v;
  }
  return n;
}

const fileDate = () => today();

/** Grey space kept on the two sides of a report narrowed to fit its window, in px. */
const FIT_GUTTER = 8;

/** A result whose rows or columns came back empty as null is shown like an empty report. */
function normalizeResult(r: ReportResult | undefined): ReportResult | undefined {
  if (!r || (Array.isArray(r.rows) && Array.isArray(r.columns) && r.params)) return r;
  return { ...r, rows: Array.isArray(r.rows) ? r.rows : [], columns: Array.isArray(r.columns) ? r.columns : [], params: r.params ?? {} };
}

/** Window title prefix of a name's activity report, by name kind. */
const NAME_ACTIVITY: Record<string, string> = { customer: 'Customer Activity: ', vendor: 'Vendor Activity: ', other: 'Other Name Activity: ' };

/** Activity reports: the record list the window title is taken from (same cache entries as the pickers). */
const QUICK_RECORD: Record<string, { param: 'accountId' | 'nameId' | 'itemId'; queryKey: unknown[]; path: string; prefix: (rec: Account | Item | Name) => string }> = {
  account_quickreport: { param: 'accountId', queryKey: ['accounts', { active: 'all' }], path: '/accounts?active=all', prefix: () => 'Account Activity: ' },
  item_quickreport: { param: 'itemId', queryKey: ['items', { active: 'all' }], path: '/items?active=all', prefix: () => 'Item Activity: ' },
  name_quickreport: { param: 'nameId', queryKey: ['names', null, { active: 'all' }], path: '/names?active=all', prefix: (rec) => NAME_ACTIVITY[(rec as Name).kind] ?? 'Activity Report: ' },
};

export default function ReportWindow(props: ReportWindowProps) {
  const w = useWindow();
  const initialKey = String(props.reportKey ?? w.props.key ?? '');
  const initial = useMemo(() => splitParams(props.params), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [key, setKey] = useState(initialKey);
  const [rp, setRpState] = useState<Record<string, string>>(initial.rp);
  const [display, setDisplayState] = useState<DisplayOptions>(initial.display);
  const [memId, setMemId] = useState<number | null>(props.memorizedId ?? null);
  const [showHeader, setShowHeader] = useState(!initial.display.noHeader);
  const [panel, setPanel] = useState(false);
  const [panelTab, setPanelTab] = useState('filters');
  const [allCollapsed, setAllCollapsed] = useState(initial.display.collapseAll);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [userWidths, setUserWidths] = useState<Record<string, number>>(() => loadWidths(initialKey));

  const prefs = usePrefValues();
  const company = useCompanyInfo().data;
  const catalogQ = useReportsCatalog();
  const catalog = catalogQ.data;
  const info = reportInfo(catalog, key);
  const required = REQUIRED_ID[key];
  const missing = !!required && !rp[required];

  // ---- params (date edits are applied after a short pause so typing does not run the report each key)
  const timer = useRef<number>();
  const pending = useRef<ParamPatch | null>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const setRp = useCallback((patch: ParamPatch, opts: { debounce?: boolean } = {}) => {
    if (opts.debounce) {
      pending.current = { ...(pending.current ?? {}), ...patch };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const p = pending.current;
        pending.current = null;
        if (p) setRpState((cur) => applyPatch(cur, p));
      }, 450);
      return;
    }
    window.clearTimeout(timer.current);
    const p = { ...(pending.current ?? {}), ...patch };
    pending.current = null;
    setRpState((cur) => applyPatch(cur, p));
  }, []);
  const setDisplay = useCallback((patch: Partial<DisplayOptions>) => setDisplayState((d) => ({ ...d, ...patch })), []);

  // a From date after the To date is caught here (the server would refuse it)
  const badRange = !!(rp.from && rp.to && rp.from > rp.to);
  // The report runs with the period its Report period box shows: before any date is chosen, the
  // report's standard preset is sent just as if it had been picked, so the server never applies
  // another rule for "no dates" (Balance Sheet: This Period vs. Last Period compared with another date).
  // Budget reports send none: they then cover the budget's own fiscal year. The catalog says which
  // preset is standard, so the report waits for it (or runs without it when it cannot be loaded).
  const known = !!catalog?.some((r) => r.key === key);
  const sendPreset =
    known &&
    (hasParam(info, 'dates') || hasParam(info, 'asOf')) &&
    !hasParam(info, 'budgetId') &&
    rp.dates === undefined &&
    rp.from === undefined &&
    rp.to === undefined &&
    rp.asOf === undefined;
  const standardPreset = info.defaultDates || 'thisMonthToDate';
  const queryParams = useMemo(() => (sendPreset ? { ...rp, dates: standardPreset } : rp), [rp, sendPreset, standardPreset]);
  const catalogReady = !!catalog || catalogQ.isError;
  const query = useReport(key, queryParams, { enabled: !missing && !badRange && !!key && catalogReady });
  const { data, error: qError, isFetching: qFetching, refetch } = query;
  // while a required record is not chosen, the old result is not shown
  const res = useMemo(() => normalizeResult(missing || badRange ? undefined : data), [missing, badRange, data]);
  const error = missing ? null : badRange ? new ApiError(400, 'validation', 'The From date must be on or before the To date.', 'from') : qError;
  const isFetching = !missing && !badRange && qFetching;

  // ---- window title
  const titledKey = useRef(initialKey);
  useEffect(() => {
    if (memId || key === titledKey.current) return;
    titledKey.current = key;
    w.setTitle(info.title);
  }, [key, info.title]); // eslint-disable-line react-hooks/exhaustive-deps

  // Activity reports name their record ("Account Activity: Savings"); choosing another record in
  // the filter bar renames the window. A title given by the opener is kept for the first record.
  const quick = QUICK_RECORD[key];
  const recordId = quick ? (rp[quick.param] ?? '') : '';
  const { data: records } = useQuery({
    queryKey: quick?.queryKey ?? ['none'],
    queryFn: ({ signal }) => api.get<(Account | Item | Name)[]>(quick!.path, { signal }),
    enabled: !!quick && !!recordId && !memId,
    staleTime: 30_000,
  });
  const titledRecord = useRef(w.props.title ? `${initialKey}|${initial.rp[QUICK_RECORD[initialKey]?.param ?? ''] ?? ''}` : '');
  useEffect(() => {
    if (memId || !quick || !recordId || !records) return;
    const tag = `${key}|${recordId}`;
    if (titledRecord.current === tag) return;
    const rec = records.find((r) => String(r.id) === recordId);
    if (!rec) return;
    titledRecord.current = tag;
    w.setTitle(quick.prefix(rec) + (rec.fullName || rec.name));
  }, [key, recordId, records, memId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- remember the report in Recent (not drill-down / transaction journal windows)
  const recorded = useRef('');
  const zoomed = ['txnId', 'accountIds', 'nameIds', 'itemIds'].some((k) => initial.rp[k]) || key.endsWith('_quickreport');
  useEffect(() => {
    if (!res || recorded.current === key || zoomed) return;
    recorded.current = key;
    recordRecentReport(key, info.title || res.title);
  }, [res, key, info.title, zoomed]);

  // ---- server problems with a field (e.g. From after To) show on that field
  const fe = useFormErrors();
  const errKey = error ? `${(error as ApiError).field ?? ''}|${(error as ApiError).message}` : '';
  useEffect(() => {
    const e = error as ApiError | null;
    if (e && e.field && e.code !== 'cancelled') fe.setErrors({ [e.field]: e.message });
    else if (fe.hasErrors) fe.clearAll();
  }, [errKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- structure, collapse
  const st = useMemo(() => (res ? analyze(res.rows) : null), [res]);
  useEffect(() => {
    if (!st) return;
    setCollapsed(allCollapsed ? collapseAllSet(st) : new Set());
  }, [st]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleRow = useCallback((i: number) => {
    setCollapsed((cur) => {
      const n = new Set(cur);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  }, []);
  const collapseAll = (on: boolean) => {
    setAllCollapsed(on);
    setCollapsed(on && st ? collapseAllSet(st) : new Set());
  };

  // ---- columns
  const resultCols: ReportColumn[] = res?.columns ?? [];
  const hiddenKey = display.hidden.join(',');
  const cols = useMemo(() => resultCols.filter((c) => c.key === 'label' || !display.hidden.includes(c.key)), [resultCols, hiddenKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const numericKeys = useMemo(() => cols.filter(isNumericCol).map((c) => c.key), [cols]);
  const sizes = useMemo(() => (res ? measureColumnSizes(res, cols, display) : null), [res, cols, display.neg, display.thousands, display.noCents]); // eslint-disable-line react-hooks/exhaustive-deps
  const natural = useMemo(() => sizes?.natural ?? {}, [sizes]);
  // room for the columns: the report area minus the paper margins/padding and a scroll bar
  const areaRef = useRef<HTMLDivElement>(null);
  const [areaW, setAreaW] = useState(0);
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaW(el.clientWidth));
    ro.observe(el);
    setAreaW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // the open Customize panel takes its room from the report (when the window is wide enough) so
  // the amounts it changes stay in view; the columns are fitted more tightly meanwhile
  const pushed = panel && areaW >= CUSTOMIZE_PANEL_WIDTH + 420;
  const roomW = pushed ? areaW - CUSTOMIZE_PANEL_WIDTH : areaW;
  // the columns get the room left by the paper's padding and border, the vertical scroll bar (a
  // long report always has one) and a few pixels of grey on each side of the paper
  const fitW = Math.max(0, roomW - PAPER_SIDES - scrollbarWidth() - FIT_GUTTER);
  const widths = useMemo(
    () => fitColumns(cols, natural, userWidths, fitW, { sizes: sizes ?? undefined, tight: panel, slack: FIT_GUTTER }),
    [cols, natural, sizes, userWidths, fitW, panel],
  );
  const onResize = useCallback(
    (k: string, px: number) => {
      setUserWidths((cur) => {
        const n = { ...cur, [k]: px };
        saveWidths(key, n);
        return n;
      });
    },
    [key],
  );

  const rows = useMemo(() => (res && st ? visibleRows(res.rows, st, collapsed, display, numericKeys) : []), [res, st, collapsed, display, numericKeys]);
  const sortable = !!st?.flat && (res?.rows.length ?? 0) > 1;
  // nothing but the zero totals the server always adds (or nothing at all): "Nothing to show"
  const empty = !!res && (rows.length === 0 || isEmptyResult(res.rows));
  const rowCount = empty ? 0 : rows.length;

  // ---- what the filter bar shows
  const echo = res?.params ?? {};
  const fy = company?.fiscalYearStartMonth || 1;
  const explicit = rp.from !== undefined || rp.to !== undefined || rp.asOf !== undefined;
  // a preset resolves the same way here as on the server; typed dates are shown as typed
  const presetKey = rp.dates && rp.dates !== 'custom' ? rp.dates : !explicit ? info.defaultDates || 'thisMonthToDate' : null;
  const local = presetKey ? resolvePreset(presetKey, today(), fy) : null;
  const shown = {
    preset: rp.dates ?? (explicit ? 'custom' : info.defaultDates || 'thisMonthToDate'),
    from: local ? local.from : (rp.from ?? echo.from ?? ''),
    to: local ? local.to : (rp.to ?? echo.to ?? ''),
    asOf: local ? local.to : (rp.asOf ?? rp.to ?? echo.asOf ?? ''),
    basis: rp.basis ?? echo.basis ?? prefs.reportBasis,
    columns: rp.columns ?? echo.columns ?? defaultColumns(key),
    budgetId: rp.budgetId ?? echo.budgetId ?? '',
  };

  const header = res ? headerText(res, display, info.title) : null;
  const title = header?.title || info.title;

  // ---- actions
  const switchReport = (k: string) => {
    if (k === key) return;
    const next = reportInfo(catalog, k);
    // filters the next report does not offer would still apply, out of sight (its Customize panel
    // could neither show nor turn them off): they are removed, with a short note (the catalog says
    // which reports offer filters, so nothing is removed while it is unknown)
    const drop = catalog?.some((r) => r.key === k) ? unusableFilters(next, rp) : { labels: [], params: [] };
    setRpState((cur) => {
      const n = { ...cur };
      if (!hasParam(next, 'columns')) delete n.columns;
      for (const p of drop.params) delete n[p];
      return n;
    });
    setKey(k);
    setUserWidths(loadWidths(k));
    if (drop.labels.length === 1) toast(`${next.title} cannot use the ${drop.labels[0]} filter, so it was removed.`, { kind: 'info' });
    else if (drop.labels.length > 1) toast(`${next.title} cannot use these filters, so they were removed: ${drop.labels.join(', ')}.`, { kind: 'info' });
  };

  const doPrint = () => {
    if (!res || !header) return;
    const { html, css } = reportPrintHtml(header, cols, widths, rows, display, sizes?.wrap ?? sizes?.long);
    void printHtml(title, html, css);
  };

  const doExport = () => {
    if (!res || !header) return;
    downloadCsv(`${title} ${fileDate()}`, reportCsvRows(header, cols, rows, display));
    toast(`Exported "${title}" to a CSV file`, { kind: 'info' });
  };

  const doMemorize = async () => {
    if (!key) return;
    const saved = await memorizeReport({
      reportKey: key,
      params: { ...rp, ...displayToParams({ ...display, collapseAll: allCollapsed, noHeader: !showHeader }) },
      defaultName: display.title.trim() || (memId ? w.props.title : '') || info.title,
      memorizedId: memId,
    });
    if (saved) {
      setMemId(saved.id);
      w.setTitle(saved.name);
      w.setKeyProps?.({ memorizedId: saved.id });
    }
  };

  const reset = () => {
    setDisplayState({ ...DEFAULT_DISPLAY });
    setRpState((cur) => {
      const keep: Record<string, string> = {};
      for (const k of ['dates', 'from', 'to', 'asOf', 'basis', 'columns', 'accountId', 'nameId', 'itemId', 'budgetId', 'agingInterval', 'agingThrough', 'txnId'])
        if (cur[k] !== undefined) keep[k] = cur[k];
      return keep;
    });
    setUserWidths({});
    saveWidths(key, {});
  };

  useHotkeys({
    // Escape closes the Customize panel first (a second Escape closes the window)
    escape: () => {
      if (!panel) return false;
      setPanel(false);
    },
    'ctrl+m': () => void doMemorize(),
    // print the report, not the whole application
    'ctrl+p': () => (res && rowCount ? doPrint() : false),
    'meta+p': () => (res && rowCount ? doPrint() : false),
  });

  // ---- placeholder content of the paper
  // a longer period cannot help when the report already covers every date (or has no dates)
  const allDates = !(hasParam(info, 'dates') || hasParam(info, 'asOf')) || shown.preset === 'all';
  let placeholder: React.ReactNode = null;
  if (missing) {
    placeholder = (
      <div className="rpt-msg">
        <div className="rpt-msg-title">{info.title}</div>
        <div>{REQUIRED_ID_PROMPT[required!]}</div>
      </div>
    );
  } else if (error && !res) {
    const e = error as ApiError;
    placeholder = e.field ? (
      <div className="rpt-msg rpt-msg-error">
        <div className="rpt-msg-title">Check the highlighted box above</div>
        <div>{e.message}</div>
      </div>
    ) : (
      <div className="rpt-msg rpt-msg-error">
        <div className="rpt-msg-title">This report could not be run</div>
        <div>{e.message || 'Something went wrong.'}</div>
        <Button label="Try again" icon={RefreshCw} onClick={() => void refetch()} />
      </div>
    );
  } else if (!res) {
    placeholder = <Spinner label="Running the report…" />;
  } else if (empty) {
    placeholder = (
      <div className="rpt-msg">
        <div className="rpt-msg-title">Nothing to show</div>
        <div>
          {allDates
            ? filterCount(rp)
              ? 'No transactions match these filters. Try removing a filter.'
              : 'There is nothing in this report yet.'
            : filterCount(rp)
              ? 'No transactions match these dates and filters. Try a longer report period or remove a filter.'
              : 'There are no transactions for these dates. Try a longer report period.'}
        </div>
      </div>
    );
  }

  const fcount = filterCount(rp) + displayChangeCount(display) + (rp.cols ? 1 : 0);
  const errorBanner = error && res ? (error as ApiError).message : null;

  return (
    <div className="rpt-win">
      <Toolbar aria-label="Report actions" className="rpt-toolbar">
        <ToolbarButton
          label={fcount ? `Customize (${fcount})` : 'Customize'}
          icon={SlidersHorizontal}
          pressed={panel}
          onClick={() => setPanel((p) => !p)}
          title="Filters, columns, header and number format"
        />
        <ToolbarButton label="Memorize" icon={BookmarkPlus} onClick={() => void doMemorize()} shortcut="Ctrl+M" disabled={!key} />
        <ToolSeparator />
        <ToolbarButton className="rpt-tb-min" label="Print" icon={Printer} onClick={doPrint} disabled={!res || !rowCount} title="Print the report" />
        <ToolbarButton
          className="rpt-tb-min"
          label="Export CSV"
          icon={Download}
          onClick={doExport}
          disabled={!res || !rowCount}
          title="Download the report as a CSV file (opens in Excel)"
        />
        <ToolSeparator />
        {st?.hasCollapsible && (
          <ToolbarButton
            label={allCollapsed || collapsed.size ? 'Expand all' : 'Collapse all'}
            icon={allCollapsed || collapsed.size ? ChevronsUpDown : ChevronsDownUp}
            onClick={() => collapseAll(!(allCollapsed || collapsed.size > 0))}
            className="rpt-tb-min"
            title={allCollapsed || collapsed.size ? 'Show every row' : 'Show only the totals of each group'}
          />
        )}
        <ToolbarButton
          label={showHeader ? 'Hide header' : 'Show header'}
          icon={Heading}
          pressed={!showHeader}
          onClick={() => setShowHeader((s) => !s)}
          className="rpt-tb-min"
          title={showHeader ? 'Hide the company name, title and dates' : 'Show the company name, title and dates'}
        />
        <ToolbarButton
          className="rpt-tb-min"
          label="Refresh"
          icon={RefreshCw}
          onClick={() => void refetch()}
          disabled={missing}
          title="Run the report again with the latest transactions"
        />
        <ToolbarSpacer />
        <span className="rpt-status" aria-live="polite">
          {isFetching ? <Spinner size={13} label="Updating…" /> : res ? `${rowCount.toLocaleString('en-US')} row${rowCount === 1 ? '' : 's'}` : null}
        </span>
      </Toolbar>
      <FormErrorsProvider value={fe}>
        <FilterBar
          info={info}
          rp={rp}
          setRp={setRp}
          shown={shown}
          onSwitchReport={switchReport}
          sort={sortable ? { value: display.sort, columns: cols, onChange: (s) => setDisplay({ sort: s }) } : null}
        />
      </FormErrorsProvider>
      {errorBanner && <div className="rpt-banner">{errorBanner}</div>}
      <div ref={areaRef} className={'rpt-area' + (isFetching && res ? ' rpt-busy' : '')} style={pushed ? { paddingRight: CUSTOMIZE_PANEL_WIDTH } : undefined}>
        <ReportPaper
          header={header ?? { company: company?.name ?? '', title: info.title, subtitle: '', basis: '', prepared: new Date() }}
          showHeader={showHeader}
          cols={res ? cols : []}
          widths={widths}
          onResize={onResize}
          rows={rows}
          display={display}
          onToggle={toggleRow}
          sortable={sortable}
          onSort={(s) => setDisplay({ sort: s })}
          placeholder={placeholder}
          resultId={res ? `${res.key}|${res.generatedAt}` : ''}
          autoFocus
          showEnd={pushed}
          wrap={sizes?.wrap ?? sizes?.long}
        />
        <CustomizePanel
          open={panel}
          onClose={() => setPanel(false)}
          info={info}
          rp={rp}
          setRp={setRp}
          display={display}
          setDisplay={setDisplay}
          resultCols={resultCols}
          defaultTitle={res?.title || info.title}
          defaultSubtitle={res?.dateRangeLabel ?? ''}
          onReset={reset}
          tab={panelTab}
          onTabChange={setPanelTab}
        />
      </div>
    </div>
  );
}
