// "Customize" side panel of the report window (ported from the SerieX Books report viewer; a
// side panel instead of a Modify Report dialog): columns, header/footer and number format. Every
// change applies at once. Payroll report filters (employee, payroll item, state...) are in the
// filter bar above the report.
import type { ReportColumn, ReportInfo } from '@/api/types';
import { Button, Checkbox, RadioGroup, SidePanel, Tabs, TextField } from '@/components';
import type { DisplayOptions, HeaderPart, NegStyle } from './reportFormat';

/** Report params patch: a key set to undefined is removed. */
export type ParamPatch = Record<string, string | undefined>;

/** Props of {@link CustomizePanel}. */
export interface CustomizePanelProps {
  open: boolean;
  onClose: () => void;
  info: ReportInfo;
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
  for (const k of ['employeeId', 'itemId', 'state', 'differences']) if (rp[k]) n++;
  if (rp.includeVoided === '1') n++;
  if (rp.active && rp.active !== 'active') n++;
  return n;
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
// Columns tab

function ColumnsTab({ display, setDisplay, resultCols }: Pick<CustomizePanelProps, 'display' | 'setDisplay' | 'resultCols'>) {
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
  const { open, onClose, tab, onTabChange, onReset } = props;
  const tabs = [
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
      width={360}
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
        {active === 'columns' && <ColumnsTab {...props} />}
        {active === 'header' && <HeaderTab {...props} />}
        {active === 'numbers' && <NumbersTab {...props} />}
      </Tabs>
    </SidePanel>
  );
}
