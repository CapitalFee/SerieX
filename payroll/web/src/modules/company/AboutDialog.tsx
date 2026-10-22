// About SerieX Payroll (Help > About) and the short built-in help (Help > SerieX Payroll Help, F1):
// how payroll works step by step, the keyboard shortcuts, and the product information (version,
// SerieX Books address, tax table years, license and source code, company file and signed-in user).
import { useEffect, useState } from 'react';
import { BookOpenCheck, Info, Keyboard } from 'lucide-react';
import { useAppInfo } from '@/api/hooks';
import { Badge, Button, SegmentedControl } from '@/components';
import { useOptionalWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import type { WindowKind } from '@/windows/kinds';
import { useSession } from '@/state/session';
import { startPayEmployees } from '@/shell/data';
import { AppIcon } from '@/shell/glyphs';
import { PRODUCT_NAME } from './shared';
import './company.css';

export interface AboutDialogProps {
  /** Opened from Help > SerieX Payroll Help (F1): start on the help pages. */
  help?: boolean;
}

type Page = 'start' | 'keys' | 'about';

// SerieX is free software under the GNU AGPL-3.0-or-later; its source code is public.
const SOURCE_URL = 'https://github.com/CapitalFee/SerieX';
const LICENSE_URL = 'https://github.com/CapitalFee/SerieX/blob/main/LICENSE';

const KEYS: [string, string][] = [
  ['Ctrl+K or /', 'Search employees, paychecks, reports and commands'],
  ['Ctrl+F', 'Find paychecks (Find and Edit Paychecks)'],
  ['Alt+S / Alt+N', 'Save and close / save and new'],
  ['Ctrl+P', 'Print the report or form'],
  ['Ctrl+F4', 'Close the window'],
  ['Esc', 'Close the window or dialog'],
  ['F1', 'This help'],
];

const DATE_KEYS: [string, string][] = [
  ['+ / -', 'Next / previous day'],
  ['T', 'Today'],
  ['W / K', 'First / last day of the week'],
  ['M / H', 'First / last day of the month'],
  ['Y / R', 'First / last day of the year'],
];

interface HelpStep {
  label: string;
  text: string;
  kind?: WindowKind;
  props?: Record<string, unknown>;
  run?: () => void;
}

const STEPS: HelpStep[] = [
  { label: 'Finish Payroll Setup', text: 'company information, state tax IDs and rates, pay schedules, payroll items, employees and amounts paid earlier this year.', kind: 'payrollSetup' },
  { label: 'Add your employees', text: 'with their pay rates, Form W-4 and state withholding, deductions and sick and vacation hours.', kind: 'employeeCenter' },
  { label: 'Pay employees', text: 'enter hours, review each paycheck, then create, print or deposit the paychecks.', run: startPayEmployees },
  { label: 'Pay payroll taxes', text: 'deposit the taxes you withheld and owe on time, from the list of taxes due.', kind: 'payLiabilities' },
  { label: 'File the payroll tax forms', text: 'Form 941 each quarter, Form 940 and W-2s each year, and the state unemployment reports.', kind: 'processForms' },
  { label: 'Run payroll reports', text: 'such as the Payroll Summary and Payroll Liability Balances.', kind: 'reportCenter' },
];

export default function AboutDialog({ help }: AboutDialogProps) {
  const win = useOptionalWindow();
  const company = useSession((s) => s.company);
  const companyId = useSession((s) => s.companyId);
  const user = useSession((s) => s.user);
  const isAdmin = useSession((s) => s.isAdmin);
  const info = useAppInfo().data;
  const [page, setPage] = useState<Page>(help ? 'start' : 'about');

  useEffect(() => {
    win?.setTitle(help ? 'SerieX Payroll Help' : 'About SerieX Payroll');
    setPage(help ? 'start' : 'about');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [help]);

  const go = (s: HelpStep) => {
    void win?.close(true).then(() => {
      if (s.run) s.run();
      else if (s.kind) openWindow(s.kind, s.props ?? {});
    });
  };

  return (
    <div className="cx-dlg">
      <div style={{ padding: '12px 20px 0' }}>
        <SegmentedControl<Page>
          size="sm"
          value={page}
          onChange={setPage}
          aria-label="Help pages"
          options={[
            { value: 'start', label: 'How payroll works', icon: BookOpenCheck },
            { value: 'keys', label: 'Keyboard', icon: Keyboard },
            { value: 'about', label: 'About', icon: Info },
          ]}
        />
      </div>
      <div className="cx-dlg-body" style={{ paddingTop: 12 }}>
        {page === 'about' && (
          <>
            <div className="cx-about-head">
              <AppIcon size={44} />
              <div>
                <div className="cx-about-name">{PRODUCT_NAME}</div>
                <div className="cx-muted">Version {info?.version ?? '...'}</div>
              </div>
            </div>
            <p className="cx-intro">Paychecks, payroll taxes, tax forms and reports for SerieX Books companies, posted to the SerieX Books company file.</p>
            <dl className="cx-kv">
              <dt>SerieX Books</dt>
              <dd>
                {info?.booksUrl ?? ''}{' '}
                {info && (
                  <Badge tone={info.booksReachable ? 'success' : 'danger'} dot>
                    {info.booksReachable ? 'Running' : 'Not reachable'}
                  </Badge>
                )}
              </dd>
              <dt>Tax tables</dt>
              <dd>{info?.taxYears?.length ? info.taxYears.join(', ') : ''}</dd>
              <dt>License</dt>
              <dd>
                <span title="Free software under the GNU Affero General Public License, version 3 or any later version">GNU AGPL-3.0-or-later</span>
                {' ('}
                <a className="sx-linkbtn" href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
                  read the license
                </a>
                )
              </dd>
              <dt>Source code</dt>
              <dd>
                <a className="sx-linkbtn" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
                  github.com/CapitalFee/SerieX
                </a>
              </dd>
              <dt>Company</dt>
              <dd className="cx-ellipsis" title={company ? `Payroll file ${companyId}.sxp` : undefined}>
                {company ? company.name : 'No company open'}
              </dd>
              {company && (
                <>
                  <dt>Signed in as</dt>
                  <dd>
                    {user || 'Admin'}
                    {isAdmin ? ' (SerieX Books administrator)' : ''}
                  </dd>
                </>
              )}
            </dl>
          </>
        )}
        {page === 'start' && (
          <div className="cx-stack" style={{ gap: 8 }}>
            <p className="cx-intro" style={{ marginBottom: 4 }}>
              Payroll works in the same order every pay period. The <b>Home</b> page and the <b>Payroll Center</b> show what is due next.
            </p>
            {company ? (
              <ol className="pc-helpsteps">
                {STEPS.map((s) => (
                  <li key={s.label}>
                    <button type="button" className="sx-linkbtn" onClick={() => go(s)}>
                      {s.label}
                    </button>
                    : {s.text}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="cx-muted" style={{ margin: 0 }}>
                Open a company that has payroll, or set up payroll for a SerieX Books company, to get started.
              </p>
            )}
            <p className="cx-muted cx-small" style={{ margin: '6px 0 0' }}>
              Look for the small <b>?</b> next to field names: it explains payroll terms in plain English.
            </p>
          </div>
        )}
        {page === 'keys' && (
          <>
            <table className="cx-keys">
              <tbody>
                {KEYS.map(([k, v]) => (
                  <tr key={k}>
                    <td>
                      <KeyCombo text={k} />
                    </td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="cx-section-title" style={{ marginTop: 14 }}>
              In date fields
            </div>
            <table className="cx-keys">
              <tbody>
                {DATE_KEYS.map(([k, v]) => (
                  <tr key={k}>
                    <td>
                      <KeyCombo text={k} />
                    </td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
      <div className="cx-dlg-foot">
        <span className="cx-grow" />
        <Button variant="primary" label="Close" autoFocus onClick={() => void win?.close()} />
      </div>
    </div>
  );
}

/** "Ctrl+K or /" → <kbd>Ctrl</kbd>+<kbd>K</kbd> or <kbd>/</kbd>. */
function KeyCombo({ text }: { text: string }) {
  const parts = text.split(/\s(or|\/)\s/);
  return (
    <>
      {parts.map((a, i) =>
        i % 2 === 1 ? (
          <span key={i} className="cx-muted">
            {' '}
            {a}{' '}
          </span>
        ) : (
          <span key={i}>
            {(a === '+' ? ['+'] : a.split('+')).map((k, j) => (
              <span key={j}>
                {j > 0 && '+'}
                <kbd className="cx-kbd">{k}</kbd>
              </span>
            ))}
          </span>
        ),
      )}
    </>
  );
}
