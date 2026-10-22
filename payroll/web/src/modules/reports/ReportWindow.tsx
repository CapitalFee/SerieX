// Report window (ported from the SerieX Books report viewer): desktop report "paper" with a filter
// bar (report period, Show columns, Employee, Payroll item...), a Customize side panel (columns,
// header/footer, number format), Print, Excel (CSV file), Collapse/Expand, Hide header, Refresh
// and drill-down (an amount or a double click opens the paycheck, tax payment, adjustment,
// employee or payroll item behind a row, or the detail report behind a total).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, Download, Heading, Printer, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { ApiError } from '@/api/client';
import type { ReportColumn } from '@/api/types';
import { useReport, useReportCatalog } from '@/api/hooks';
import { Button, FormErrorsProvider, Spinner, Toolbar, ToolbarButton, ToolbarSpacer, ToolSeparator, toast, useFormErrors, useHotkeys } from '@/components';
import { downloadCsv } from '@/util/csv';
import { printHtml } from '@/util/print';
import { resolvePreset } from '@/util/dates';
import { today, useSession } from '@/state/session';
import { useWindow } from '@/windows/WindowContext';
import { CustomizePanel, filterCount, type ParamPatch } from './CustomizePanel';
import { FilterBar } from './FilterBar';
import { ReportPaper } from './ReportPaper';
import {
  DEFAULT_DISPLAY,
  analyze,
  collapseAllSet,
  displayChangeCount,
  fitColumns,
  headerText,
  isNumericCol,
  measureColumns,
  reportCsvRows,
  reportPrintHtml,
  splitParams,
  visibleRows,
  type DisplayOptions,
} from './reportFormat';
import { defaultColumns, hasParam, reportInfo } from './reportMeta';
import { recordRecentReport } from './reportStore';
import './reports.css';

/** Window props. The report key is `useWindow().props.key` (React never passes a prop named `key`; the shell also passes it as `reportKey`). */
export interface ReportWindowProps {
  reportKey?: string;
  params?: Record<string, string>;
  title?: string;
}

function widthsKey(key: string) {
  return `sxp.rpt.w.${key}`;
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

const quarterOf = (iso: string) => String(Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1);

export default function ReportWindow(props: ReportWindowProps) {
  const w = useWindow();
  const key = String(props.reportKey ?? w.props.key ?? '');
  const initial = useMemo(() => splitParams(props.params ?? w.props.params), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [rp, setRpState] = useState<Record<string, string>>(initial.rp);
  const [display, setDisplayState] = useState<DisplayOptions>(initial.display);
  const [showHeader, setShowHeader] = useState(!initial.display.noHeader);
  const [panel, setPanel] = useState(false);
  const [panelTab, setPanelTab] = useState('columns');
  const [allCollapsed, setAllCollapsed] = useState(initial.display.collapseAll);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [userWidths, setUserWidths] = useState<Record<string, number>>(() => loadWidths(key));

  const companyName = useSession((s) => s.company?.name ?? '');
  const { data: catalog } = useReportCatalog();
  const info = reportInfo(catalog, key);

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
  const query = useReport(key, rp, { enabled: !badRange && !!key });
  const { data, error: qError, isFetching: qFetching, refetch } = query;
  const res = badRange ? undefined : data;
  const error = badRange ? new ApiError(400, 'validation', 'The From date must be on or before the To date.', 'from') : qError;
  const isFetching = !badRange && qFetching;

  // ---- window title
  useEffect(() => {
    if (!props.title && !w.props.title && info.title) w.setTitle(info.title);
  }, [key, info.title]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- remember the report in Recent (not drill-down windows opened for one record)
  const recorded = useRef('');
  const zoomed = ['employeeId', 'itemId'].some((k) => initial.rp[k]);
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
  const natural = useMemo(() => (res ? measureColumns(res, cols, display) : {}), [res, cols, display.neg, display.thousands, display.noCents]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const widths = useMemo(() => fitColumns(cols, natural, userWidths, Math.max(0, areaW - 86)), [cols, natural, userWidths, areaW]);
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

  // ---- what the filter bar shows
  const echo = res?.params ?? {};
  const explicit = rp.from !== undefined || rp.to !== undefined || rp.asOf !== undefined;
  // a preset resolves the same way here as on the server (calendar quarters and years)
  const presetKey = rp.dates && rp.dates !== 'custom' ? rp.dates : !explicit ? info.defaultDates || 'thisMonthToDate' : null;
  const local = presetKey ? resolvePreset(presetKey, today(), 1) : null;
  const toShown = local ? local.to : (rp.to ?? echo.to ?? '');
  const shown = {
    preset: rp.dates ?? (explicit ? 'custom' : info.defaultDates || 'thisMonthToDate'),
    from: local ? local.from : (rp.from ?? echo.from ?? ''),
    to: toShown,
    asOf: local ? local.to : (rp.asOf ?? rp.to ?? echo.asOf ?? ''),
    columns: rp.columns ?? echo.columns ?? defaultColumns(key),
    year: rp.year ?? echo.year ?? (toShown || today()).slice(0, 4),
    quarter: rp.quarter ?? echo.quarter ?? quarterOf(toShown || today()),
  };

  const header = res ? headerText(res, display, info.title) : null;
  const title = header?.title || info.title;

  // ---- actions
  const doPrint = () => {
    if (!res || !header) return;
    const { html, css } = reportPrintHtml(header, cols, widths, rows, display);
    void printHtml(title, html, css);
  };

  const doExport = () => {
    if (!res || !header) return;
    downloadCsv(`${title} ${today()}`, reportCsvRows(header, cols, rows, display));
    toast(`Exported "${title}" to a CSV file you can open in Excel`, { kind: 'info' });
  };

  const reset = () => {
    setDisplayState({ ...DEFAULT_DISPLAY });
    setUserWidths({});
    saveWidths(key, {});
  };

  useHotkeys({
    // Escape closes the Customize panel first (a second Escape closes the window)
    escape: () => {
      if (!panel) return false;
      setPanel(false);
    },
    // print the report, not the whole application
    'ctrl+p': () => (res && rows.length ? doPrint() : false),
    'meta+p': () => (res && rows.length ? doPrint() : false),
  });

  // ---- placeholder content of the paper
  let placeholder: React.ReactNode = null;
  if (!key) {
    placeholder = (
      <div className="rpt-msg">
        <div className="rpt-msg-title">No report chosen</div>
        <div>Open a report from the Report Center or the Reports menu.</div>
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
  } else if (rows.length === 0) {
    placeholder = (
      <div className="rpt-msg">
        <div className="rpt-msg-title">Nothing to show</div>
        <div>
          {filterCount(rp)
            ? 'Nothing matches these dates and filters. Try a longer report period or choose "All" in a filter.'
            : hasParam(info, 'dates')
              ? 'There are no payroll transactions for these dates. Try a longer report period.'
              : 'There is nothing to list yet.'}
        </div>
      </div>
    );
  }

  const fcount = displayChangeCount(display);
  const errorBanner = error && res ? (error as ApiError).message : null;

  return (
    <div className="rpt-win">
      <Toolbar aria-label="Report actions" className="rpt-toolbar">
        <ToolbarButton
          label={fcount ? `Customize (${fcount})` : 'Customize'}
          icon={SlidersHorizontal}
          pressed={panel}
          onClick={() => setPanel((p) => !p)}
          title="Columns, header and number format"
        />
        <ToolSeparator />
        <ToolbarButton className="rpt-tb-min" label="Print" icon={Printer} onClick={doPrint} disabled={!res || !rows.length} title="Print the report (Ctrl+P)" />
        <ToolbarButton
          className="rpt-tb-min"
          label="Export CSV"
          icon={Download}
          onClick={doExport}
          disabled={!res || !rows.length}
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
        <ToolbarButton className="rpt-tb-min" label="Refresh" icon={RefreshCw} onClick={() => void refetch()} disabled={!key} title="Run the report again with the latest payroll data" />
        <ToolbarSpacer />
        <span className="rpt-status" aria-live="polite">
          {isFetching ? <Spinner size={13} label="Updating…" /> : res ? `${rows.length.toLocaleString('en-US')} row${rows.length === 1 ? '' : 's'}` : null}
        </span>
      </Toolbar>
      <FormErrorsProvider value={fe}>
        <FilterBar info={info} rp={rp} setRp={setRp} shown={shown} sort={sortable ? { value: display.sort, columns: cols, onChange: (s) => setDisplay({ sort: s }) } : null} />
      </FormErrorsProvider>
      {errorBanner && <div className="rpt-banner">{errorBanner}</div>}
      <div ref={areaRef} className={'rpt-area' + (isFetching && res ? ' rpt-busy' : '')}>
        <ReportPaper
          header={header ?? { company: companyName, title: info.title, subtitle: '', basis: '', prepared: new Date() }}
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
        />
        <CustomizePanel
          open={panel}
          onClose={() => setPanel(false)}
          info={info}
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
