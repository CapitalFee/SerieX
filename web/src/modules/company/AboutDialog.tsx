// About SerieX Books (Help > About) and the short built-in help (Help > SerieX Books Help, F1):
// product information, getting-started links and the keyboard shortcuts.
import { useEffect, useState } from 'react';
import { BookOpenCheck, Keyboard, Info } from 'lucide-react';
import { Button, SegmentedControl } from '@/components';
import { useOptionalWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { useSession } from '@/state/session';
import { PRODUCT_NAME, useProductVersion } from './shared';
import './company.css';

export interface AboutDialogProps {
  /** Opened from Help > SerieX Books Help (F1): start on the help pages. */
  help?: boolean;
}

type Page = 'start' | 'keys' | 'about';

const SOURCE_URL = 'https://github.com/CapitalFee/SerieX';
const LICENSE_URL = 'https://github.com/CapitalFee/SerieX/blob/main/LICENSE';

const KEYS: [string, string][] = [
  ['Ctrl+K or /', 'Search everything (customers, transactions, reports, commands)'],
  ['Ctrl+I', 'Create invoices'],
  ['Ctrl+J', 'Customers'],
  ['Ctrl+A', 'Chart of Accounts'],
  ['Ctrl+R', 'Open a register'],
  ['Alt+W', 'Write checks'],
  ['Ctrl+F', 'Find transactions'],
  ['Ctrl+Q', 'Activity report of the selected list entry'],
  ['Ctrl+E / Ctrl+D', 'Edit / delete the selected entry or transaction'],
  ['Ctrl+M', 'Memorize the transaction'],
  ['Ctrl+H / Ctrl+Y', 'Transaction history / transaction journal'],
  ['Alt+S / Alt+N', 'Save and close / save and new'],
  ['Ctrl+Ins / Ctrl+Del', 'Insert / delete a line in a transaction'],
  ['Esc', 'Close the window or dialog'],
];

const DATE_KEYS: [string, string][] = [
  ['+ / -', 'Next / previous day'],
  ['T', 'Today'],
  ['W / K', 'First / last day of the week'],
  ['M / H', 'First / last day of the month'],
  ['Y / R', 'First / last day of the year'],
  ['[ / ]', 'Previous / next week'],
];

export default function AboutDialog({ help }: AboutDialogProps) {
  const win = useOptionalWindow();
  const company = useSession((s) => s.company);
  const user = useSession((s) => s.user);
  const version = useProductVersion();
  const [page, setPage] = useState<Page>(help ? 'start' : 'about');

  useEffect(() => {
    win?.setTitle(help ? 'SerieX Books Help' : 'About SerieX Books');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [help]);

  const go = (fn: () => void) => {
    void win?.close(true).then(fn);
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
            { value: 'start', label: 'Getting started', icon: BookOpenCheck },
            { value: 'keys', label: 'Keyboard', icon: Keyboard },
            { value: 'about', label: 'About', icon: Info },
          ]}
        />
      </div>
      <div className="cx-dlg-body" style={{ paddingTop: 12 }}>
        {page === 'about' && (
          <>
            <div className="cx-about-head">
              <div className="cx-logo" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M5 7h14M5 12h10M5 17h7" />
                </svg>
              </div>
              <div>
                <div className="cx-about-name">{PRODUCT_NAME}</div>
                <div className="cx-muted">{version && `Version ${version}`}</div>
              </div>
            </div>
            <p className="cx-intro" style={{ margin: '8px 0' }}>
              Bookkeeping for small businesses: invoices, bills, banking, inventory, sales tax and reports.
            </p>
            <div className="cx-muted cx-small" style={{ lineHeight: 1.5 }}>
              <p style={{ margin: '0 0 6px' }}>
                © 2026 SerieX contributors. SerieX comes with ABSOLUTELY NO WARRANTY. It is free software: you can share and change it under the GNU
                Affero General Public License, version 3 or later.{' '}
                <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
                  Read the license
                </a>
                {' · '}
                <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
                  Source code
                </a>
              </p>
              <p style={{ margin: '0 0 6px' }}>
                Bookkeeping software, not tax, legal or accounting advice. QuickBooks is a registered trademark of Intuit Inc. SerieX is an independent
                project and is not affiliated with, endorsed by, or sponsored by Intuit Inc.
              </p>
              <p style={{ margin: 0 }}>
                {company ? `Company file: ${company.name} (${company.companyId}.sxb) · Logged in as ${user || 'Admin'}` : 'No company open'}
              </p>
            </div>
          </>
        )}
        {page === 'start' && (
          <div className="cx-stack" style={{ gap: 8 }}>
            <p className="cx-intro" style={{ marginBottom: 4 }}>
              The <b>Home</b> page shows the usual order of work. Use <b>+ New</b> to create anything, and the search bar at the top to find a customer, a
              transaction or a command.
            </p>
            {company ? (
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
                <li>
                  <button type="button" className="sx-linkbtn" onClick={() => go(() => openWindow('home'))}>
                    Open the Home page
                  </button>{' '}
                  to see what needs attention.
                </li>
                <li>
                  <button type="button" className="sx-linkbtn" onClick={() => go(() => openWindow('invoice'))}>
                    Create an invoice
                  </button>
                  , then receive the payment and deposit it.
                </li>
                <li>
                  <button type="button" className="sx-linkbtn" onClick={() => go(() => openWindow('bill'))}>
                    Enter a bill
                  </button>{' '}
                  when it arrives and pay it later with Pay Bills.
                </li>
                <li>
                  <button type="button" className="sx-linkbtn" onClick={() => go(() => openWindow('reportCenter'))}>
                    Run reports
                  </button>{' '}
                  such as Profit &amp; Loss and Balance Sheet.
                </li>
                <li>
                  <button type="button" className="sx-linkbtn" onClick={() => go(() => openWindow('preferences'))}>
                    Set your preferences
                  </button>{' '}
                  to turn features such as sales tax and inventory on or off.
                </li>
              </ul>
            ) : (
              <p className="cx-muted" style={{ margin: 0 }}>
                Open a company file, create a new one, or explore the sample company to get started.
              </p>
            )}
            <p className="cx-muted cx-small" style={{ margin: '6px 0 0' }}>
              Look for the small <b>?</b> next to field names: it explains accounting terms in plain English.
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
  // even indexes: key combos; odd indexes: separators ("or", "/")
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
